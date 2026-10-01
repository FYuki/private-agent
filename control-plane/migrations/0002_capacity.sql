ALTER TABLE runs ADD COLUMN auth_group TEXT;
ALTER TABLE runs ADD COLUMN hold_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX reservations ON runs(auth_group,hold_until);
