CREATE TABLE IF NOT EXISTS pulse_presence (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_id TEXT,
  country TEXT,
  edge TEXT,
  lat REAL,
  lon REAL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pulse_presence_seen ON pulse_presence(last_seen);
CREATE INDEX IF NOT EXISTS idx_pulse_presence_project ON pulse_presence(project_id,last_seen);
