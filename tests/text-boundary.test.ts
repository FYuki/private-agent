import test from 'node:test';
import assert from 'node:assert/strict';
import { Fault, str } from '../shared/contracts.ts';

function assertInvalidText(value: unknown, max: number): void {
  assert.throws(() => str(value, max), error => {
    assert.ok(error instanceof Fault);
    assert.equal(error.status, 400);
    assert.equal(error.message, 'invalid_text');
    return true;
  });
}

test('Japanese text is accepted at the exact UTF-8 byte limit', () => {
  assert.equal(str('ああ', 6), 'ああ');
});

test('Japanese text exceeding the byte limit is rejected even when its character count fits', () => {
  assertInvalidText('あああ', 6);
});

test('emoji is accepted at the exact UTF-8 byte limit', () => {
  assert.equal(str('😀', 4), '😀');
});

test('emoji exceeding the byte limit is rejected even when its character count fits', () => {
  assertInvalidText('😀😀', 4);
});

test('empty, whitespace-only, and non-string values are invalid text', () => {
  for (const value of ['', ' \t\n ', null, 42, {}]) {
    assertInvalidText(value, 100);
  }
});

test('forbidden control characters are invalid text', () => {
  for (const value of ['a\u0000b', 'a\u0008b', 'a\u000bb', 'a\u000cb', 'a\u000eb', 'a\u001fb']) {
    assertInvalidText(value, 100);
  }
});

test('embedded tab and newline are accepted without changing the text', () => {
  assert.equal(str('a\tb\nc', 100), 'a\tb\nc');
});

test('surrounding whitespace of nonempty text is preserved', () => {
  assert.equal(str('  あ \t', 100), '  あ \t');
});
