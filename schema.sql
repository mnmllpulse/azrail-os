-- AZRAIL — D1 схема (azrail-db, uuid c76e7d92-648c-45bc-b0df-f26b00d0ff88)
--
-- Статус: применена полностью и сверена напрямую по sqlite_master (2026-08-08).
-- На момент применения users/projects уже существовали с более узкой схемой
-- (из более ранней сессии, не отсюда) — досозданы через ALTER TABLE ADD COLUMN,
-- а не пересозданы, чтобы не терять данные. Если разворачиваешь схему на
-- ЧИСТОЙ D1 (например, для другого окружения) — этот файл создаст users/projects
-- сразу с нужными колонками через обычный CREATE TABLE, ALTER не понадобится.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  stack TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  r2_prefix TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS project_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  r2_object_key TEXT NOT NULL,
  summary TEXT,
  created_by_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS task_history (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  agent TEXT NOT NULL,
  intent TEXT,
  input_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  input_summary TEXT,
  output_summary TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS project_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL, -- architecture_decision | code_style | tech_choice | known_issue | preference
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_project_key ON project_memory(project_id, category, key);
CREATE INDEX IF NOT EXISTS idx_versions_project ON project_versions(project_id);
CREATE INDEX IF NOT EXISTS idx_history_project ON task_history(project_id);

-- ─── Диалоги и миссии ────────────────────────────────────────────────────
-- Переписка живёт в D1, а не в SQLite конкретного Durable Object: диалогов
-- много, они должны переживать выгрузку объекта и быть видны из любого
-- роута. parent_message_id даёт ветвление правок — правка старого
-- сообщения создаёт ветку, а не переписывает историю.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL DEFAULT 'AZRAIL Chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_message_id TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  conversation_id TEXT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  current_step TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Момент завершения. Колонки не было, а код её записывал: каждая миссия
  -- падала бы на UPDATE с "no such column". Поймано сверкой SQL со схемой,
  -- а не тестами — tsc и vitest про имена колонок ничего не знают.
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS mission_events (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at TEXT,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_mission_events ON mission_events(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_mission ON tool_calls(mission_id, started_at);

CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);

-- ─────────────────────────────────────────────────────────────────────
-- ПЛАН МИССИИ.
--
-- Раньше плана как сущности не было вовсе: модель на каждом шаге решала
-- заново, глядя на историю вызовов. Для коротких задач это работает, для
-- длинных — нет: цель размывается, и жёсткий потолок в 20 шагов был не
-- защитой, а симптомом того, что система не умеет разбивать большую
-- задачу на части.
--
-- План лежит в базе, а не в памяти: миссия должна переживать выгрузку
-- объекта и быть видимой снаружи — по нему строится показ прогресса и
-- по нему же видно, где именно всё встало.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_steps (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  -- pending | doing | done | skipped
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mission_steps_mission ON mission_steps(mission_id, position);

-- ─────────────────────────────────────────────────────────────────────
-- ПРОВЕРКИ ПЕРЕД ЗАВЕРШЕНИЕМ.
--
-- Записываются ВСЕ проверки, включая отклонённые. Без этого нельзя
-- отличить «задача была простая» от «проверяющий всё пропускает»: если
-- отказов не бывает никогда, проверка декоративная, и это должно быть
-- видно по данным, а не по ощущению.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_checks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mission_checks_mission ON mission_checks(mission_id);
