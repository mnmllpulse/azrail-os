-- The migration runner adds studio_artifacts.project_id only when absent.
-- ALTER TABLE studio_artifacts ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS studio_artifacts_project ON studio_artifacts(account_id,project_id,created_at);

-- A separate table deliberately preserves unassigned legacy drafts unchanged.
CREATE TABLE IF NOT EXISTS project_studio_drafts (
 account_id TEXT NOT NULL, project_id TEXT NOT NULL, studio_id TEXT NOT NULL,
 revision INTEGER NOT NULL, values_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(account_id,project_id,studio_id)
);
CREATE TABLE IF NOT EXISTS studio_storage_accounts (
 account_id TEXT PRIMARY KEY,
 byte_limit INTEGER NOT NULL CHECK(byte_limit>=0),
 file_limit INTEGER NOT NULL CHECK(file_limit>=0)
);
CREATE TABLE IF NOT EXISTS studio_storage_reservations (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, r2_key TEXT NOT NULL UNIQUE,
 bytes INTEGER NOT NULL CHECK(bytes>=0),
 status TEXT NOT NULL CHECK(status IN ('reserved','committed','deleting','cleanup','uncertain','released')),
 request_key TEXT, request_digest TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(account_id,request_key)
);
CREATE INDEX IF NOT EXISTS studio_storage_owner ON studio_storage_reservations(account_id,status);
CREATE INDEX IF NOT EXISTS studio_storage_cleanup ON studio_storage_reservations(status,updated_at);
-- Existing files count against the quota immediately, including unassigned files.
INSERT INTO studio_storage_accounts(account_id,byte_limit,file_limit)
 SELECT DISTINCT account_id,134217728,1000 FROM studio_artifacts WHERE 1
 ON CONFLICT DO NOTHING;
INSERT INTO studio_storage_reservations(id,account_id,r2_key,bytes,status,created_at,updated_at)
 SELECT id,account_id,r2_key,bytes,'committed',created_at,created_at FROM studio_artifacts WHERE 1
 ON CONFLICT DO NOTHING;
