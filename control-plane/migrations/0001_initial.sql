CREATE TABLE jobs (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, spec TEXT NOT NULL,
 name TEXT NOT NULL, provider TEXT NOT NULL, prompt TEXT NOT NULL,
 start_at INTEGER NOT NULL, interval_seconds INTEGER NOT NULL, max_runs INTEGER NOT NULL,
 enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(owner,request_key)
);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), owner TEXT NOT NULL,
 slot INTEGER NOT NULL, due_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0,
 token TEXT, worker TEXT, lease_until INTEGER, deadline INTEGER, result TEXT, error TEXT,
 UNIQUE(job_id,slot)
);
CREATE INDEX runnable ON runs(owner,state,due_at);
CREATE TABLE attempts (
 token TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), owner TEXT NOT NULL,
 number INTEGER NOT NULL, worker TEXT NOT NULL, started_at INTEGER NOT NULL,
 ended_at INTEGER, outcome TEXT NOT NULL DEFAULT 'running'
);
CREATE TRIGGER record_attempt AFTER UPDATE OF token ON runs
WHEN NEW.token IS NOT NULL AND NEW.token IS NOT OLD.token
BEGIN
 INSERT INTO attempts(token,run_id,owner,number,worker,started_at)
 VALUES(NEW.token,NEW.id,NEW.owner,NEW.attempt,NEW.worker,NEW.deadline-60000);
END;
CREATE TRIGGER finish_attempt AFTER UPDATE OF state ON runs
WHEN OLD.state='running' AND NEW.state!='running'
BEGIN
 UPDATE attempts SET outcome=NEW.state, ended_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE token=OLD.token;
END;
