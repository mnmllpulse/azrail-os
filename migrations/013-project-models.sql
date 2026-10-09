CREATE TABLE IF NOT EXISTS project_model_settings (
  project_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL
);
