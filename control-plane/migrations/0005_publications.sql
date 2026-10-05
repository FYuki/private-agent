-- Separate post-run approval and audit log. Never renew a development run lease.
CREATE TABLE development_publications (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, approved_by TEXT NOT NULL,
 request_key TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES development_tasks(id),
 artifact_id TEXT NOT NULL, repo_id TEXT NOT NULL, branch TEXT NOT NULL,
 spec TEXT NOT NULL, artifact TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'approved', superseded_at INTEGER,
 UNIQUE(owner,request_key)
);
CREATE UNIQUE INDEX active_publication_artifact ON development_publications(artifact_id) WHERE state!='superseded';
CREATE UNIQUE INDEX active_publication_branch ON development_publications(repo_id,branch) WHERE state!='superseded';
CREATE TABLE publication_operations (
 publication_id TEXT NOT NULL REFERENCES development_publications(id),
 name TEXT NOT NULL CHECK(name IN ('push','pull-request')),
 worker TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'reserved', result TEXT,
 created_at INTEGER NOT NULL, completed_at INTEGER,
 PRIMARY KEY(publication_id,name)
);
