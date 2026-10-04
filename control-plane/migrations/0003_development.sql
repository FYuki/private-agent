ALTER TABLE jobs ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'answer';
ALTER TABLE jobs ADD COLUMN budget_ms INTEGER NOT NULL DEFAULT 60000;
ALTER TABLE runs ADD COLUMN started_at INTEGER;
CREATE TABLE development_tasks (
 id TEXT PRIMARY KEY REFERENCES jobs(id), owner TEXT NOT NULL, request_key TEXT NOT NULL,
 spec TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(owner,request_key)
);
CREATE TABLE development_operations (
 task_id TEXT NOT NULL REFERENCES development_tasks(id), name TEXT NOT NULL,
 fingerprint TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'reserved', result TEXT,
 PRIMARY KEY(task_id,name)
);
CREATE TABLE development_workers (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, capabilities TEXT NOT NULL, reason TEXT,
 last_seen INTEGER NOT NULL
);
DROP TRIGGER record_attempt;
CREATE TRIGGER record_attempt AFTER UPDATE OF token ON runs
WHEN NEW.token IS NOT NULL AND NEW.token IS NOT OLD.token
BEGIN
 INSERT INTO attempts(token,run_id,owner,number,worker,started_at)
 VALUES(NEW.token,NEW.id,NEW.owner,NEW.attempt,NEW.worker,COALESCE(NEW.started_at,NEW.deadline-60000));
END;
