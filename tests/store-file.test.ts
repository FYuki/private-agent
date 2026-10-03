import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync, linkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDatabaseFile, SqliteRunStore } from '../agent/store.ts';

test('database is private before SQLite opens and survives reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-permission-')), path = join(dir, 'state.db');
  try {
    prepareDatabaseFile(path);
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(path).size, 0);
    let store = new SqliteRunStore(path); const acquired = store.acquire('o/r', 'f'); assert.equal(acquired.kind, 'acquired');
    store.close(); store = new SqliteRunStore(path); assert.equal(store.acquire('o/r', 'f').kind, 'busy'); store.close();
  } finally { rmSync(dir, { recursive: true }); }
});

test('insecure existing DB is rejected without chmod or modifying its contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-permission-')), path = join(dir, 'state.db');
  try {
    writeFileSync(path, 'fixture'); chmodSync(path, 0o644);
    assert.throws(() => new SqliteRunStore(path), /unsafe_store_file/);
    assert.equal(statSync(path).mode & 0o777, 0o644); assert.equal(readFileSync(path, 'utf8'), 'fixture');
  } finally { rmSync(dir, { recursive: true }); }
});

test('links and writable directory are rejected without touching their target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-permission-')), target = join(dir, 'target');
  try {
    writeFileSync(target, 'fixture', { mode: 0o600 }); symlinkSync(target, join(dir, 'symbolic')); linkSync(target, join(dir, 'hard'));
    assert.throws(() => new SqliteRunStore(join(dir, 'symbolic')));
    assert.throws(() => new SqliteRunStore(join(dir, 'hard')), /unsafe_store_file/);
    chmodSync(dir, 0o777);
    assert.throws(() => new SqliteRunStore(join(dir, 'new.db')), /unsafe_store_directory/);
    assert.equal(readFileSync(target, 'utf8'), 'fixture');
  } finally { rmSync(dir, { recursive: true }); }
});
