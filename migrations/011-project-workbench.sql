-- Metadata revisions are independent of mission/file updates to projects.updated_at.
CREATE TABLE IF NOT EXISTS project_workbench (
 project_id TEXT PRIMARY KEY REFERENCES projects(id),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
CREATE INDEX IF NOT EXISTS idx_projects_workbench_list ON projects(status,updated_at DESC,id DESC);
-- A preview is a temporary bearer capability on a dedicated origin. Record its
-- exact host to enforce expiry and permission revocation before SDK forwarding.
CREATE TABLE IF NOT EXISTS workbench_previews (
 hostname TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 account_id TEXT NOT NULL,
 sandbox_name TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workbench_previews_project ON workbench_previews(project_id);
-- Separate manifest proves completeness, including intentionally empty versions.
CREATE TABLE IF NOT EXISTS workbench_version_manifests (
 version_id TEXT PRIMARY KEY REFERENCES project_versions(id),
 project_id TEXT NOT NULL REFERENCES projects(id),
 manifest_json TEXT NOT NULL
);
