import { test } from 'node:test';
import assert from 'node:assert/strict';
import { developmentStatusLabel } from '../shared/development-status.ts';

test('developmentStatusLabel returns Japanese labels for known and unknown states', () => {
  assert.equal(developmentStatusLabel('queued'), '待機中');
  assert.equal(developmentStatusLabel('running'), '実行中');
  assert.equal(developmentStatusLabel('succeeded'), '完了');
  assert.equal(developmentStatusLabel('failed'), '失敗');
  assert.equal(developmentStatusLabel('cancelled'), 'キャンセル済み');
  assert.equal(developmentStatusLabel('unknown'), '不明');
});
