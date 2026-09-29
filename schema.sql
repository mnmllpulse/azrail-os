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

-- finished_at: момент завершения. Колонки не было, а код её записывал: каждая
-- миссия падала бы на UPDATE с "no such column". Поймано сверкой SQL со
-- схемой, а не тестами — tsc и vitest про имена колонок ничего не знают.
--
-- result_json: итог миссии (TaskResult в JSON). Появился вместе с переносом
-- миссии в фон: POST возвращается до начала работы, и результат больше
-- некуда положить в ответ. На УЖЕ РАЗВЁРНУТОЙ базе колонки нет — применить
-- migrations/002-mission-async.sql. Код без неё не падает, но отчёт
-- остаётся без итогового текста.
--
-- Оба комментария вынесены НАД CREATE TABLE, а не между колонками: node:sqlite
-- (DatabaseSync, используется в tests/stubs/sqlite-d1.ts) при ALTER TABLE ...
-- DROP COLUMN переписывает исходный текст CREATE TABLE и ломается на
-- "incomplete input", если многострочный комментарий стоит прямо перед
-- удаляемой колонкой. Проверено эмпирически: без межколоночных комментариев
-- DROP COLUMN проходит; с ними — нет, независимо от языка и длины строки.
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
  finished_at TEXT,
  result_json TEXT
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
-- По нему ходит сборщик зависших миссий (крон, lib/mission-state.ts).
CREATE INDEX IF NOT EXISTS idx_missions_status_updated ON missions(status, updated_at);
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


-- ── Измеритель качества (миграция 003) ────────────────────────────────
-- Одно число ничего не значит, пока не с чем сравнить: смысл измерителя
-- целиком в сравнении сегодняшнего прогона со вчерашним.
CREATE TABLE IF NOT EXISTS bench_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  measured INTEGER NOT NULL DEFAULT 0,
  solved INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  regressed INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  unmeasured INTEGER NOT NULL DEFAULT 0,
  median_ms INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS bench_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  difficulty TEXT,
  verdict TEXT NOT NULL,
  before_ok INTEGER,
  after_ok INTEGER,
  before_passed INTEGER,
  after_passed INTEGER,
  mission_status TEXT,
  mission_id TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  FOREIGN KEY (run_id) REFERENCES bench_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_bench_results_run ON bench_results(run_id, case_id);
CREATE INDEX IF NOT EXISTS idx_bench_results_case ON bench_results(case_id, run_id);

-- Apply before deploying 0.6.3. Safe to repeat; no existing tables are changed.
CREATE TABLE IF NOT EXISTS request_quotas (
  scope TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK (used >= 0),
  PRIMARY KEY (scope, bucket)
);
CREATE INDEX IF NOT EXISTS idx_request_quotas_bucket ON request_quotas(bucket);
CREATE TABLE IF NOT EXISTS websocket_tickets (
  ticket TEXT PRIMARY KEY,
  caller TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_websocket_tickets_expiry ON websocket_tickets(expires_at);

CREATE TABLE IF NOT EXISTS mission_admissions (
  key TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  claim TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  response_body TEXT,
  response_status INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mission_admissions_expiry ON mission_admissions(expires_at);

CREATE INDEX IF NOT EXISTS idx_missions_project_status ON missions(project_id, status);
CREATE TABLE IF NOT EXISTS access_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS resource_owners (
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY(kind,resource_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_account ON resource_owners(account_id,kind);
CREATE TABLE IF NOT EXISTS project_permissions (
  project_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY(project_id,capability)
);
CREATE TABLE IF NOT EXISTS operation_locks (
  project_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_outbox (
  mission_id TEXT PRIMARY KEY,
  params TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_checkpoints (
  mission_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(mission_id,step)
);
CREATE TABLE IF NOT EXISTS model_prices (
  model TEXT PRIMARY KEY,
  input_micro_usd_per_million INTEGER NOT NULL,
  output_micro_usd_per_million INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spend_limits (
  scope TEXT PRIMARY KEY,
  limit_micro_usd INTEGER NOT NULL,
  spent_micro_usd INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
  actual_micro_usd INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS backup_manifests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  file_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_snapshots (
  mission_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_heads (
  project_id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_routing_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allow_third_party INTEGER NOT NULL DEFAULT 0 CHECK (allow_third_party IN (0,1)),
  monthly_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (monthly_micro_usd >= 0),
  revision INTEGER NOT NULL DEFAULT 0
);

-- 0.8.2: models connected by hand. Mirrors migrations/008-custom-models.sql —
-- that file explains WHY these rows live apart from src/lib/model-registry.ts.
-- Kept in sync on purpose: schema.sql is the fresh-install path and never
-- replays migrations, so a table missing here would be missing forever on a
-- new database while existing ones get it from the migration.
CREATE TABLE IF NOT EXISTS custom_models (
  slug TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('frontier','balanced','fast')),
  capabilities TEXT NOT NULL,
  context_window INTEGER CHECK (context_window IS NULL OR context_window > 0),
  requires_gateway INTEGER NOT NULL CHECK (requires_gateway IN (0,1)),
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);

-- 0.8.1: atomic in-flight hints, safe to reapply.
CREATE TABLE IF NOT EXISTS mission_hints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mission_hints_queue ON mission_hints(mission_id,expires_at);
CREATE INDEX IF NOT EXISTS idx_mission_hints_expiry ON mission_hints(expires_at);
