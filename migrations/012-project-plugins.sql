CREATE TABLE IF NOT EXISTS project_plugin_policies (
 project_id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision > 0),
 plugins_json TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);
ALTER TABLE connector_calls ADD COLUMN project_id TEXT;
ALTER TABLE connector_calls ADD COLUMN plugin_revision INTEGER;
CREATE INDEX IF NOT EXISTS connector_call_project ON connector_calls(project_id, created_at);
CREATE TABLE IF NOT EXISTS connector_oauth_refresh (
 connection_id TEXT PRIMARY KEY,
 attempt_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('refreshing','reconnect_required')),
 started_at INTEGER NOT NULL
);
