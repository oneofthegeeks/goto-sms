import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../src/index.js';

test('NANP loose formats', () => {
  for (const s of [
    '(801) 555-0123',
    '801.555.0123',
    '1 801 555 0123',
    '+1 801-555-0123',
    ' 8015550123 ',
  ])
    assert.equal(normalizePhone(s), '+18015550123');
});

test('NANP rules: area/exchange start 2-9, no N11 area', () => {
  for (const s of ['1015550123', '8011550123', '9115550123']) assert.equal(normalizePhone(s), null);
});

test('junk is null', () => {
  for (const s of [
    '555-0123',
    'call me',
    '+1',
    '',
    '+12',
    '801-555-0123 ext 4',
    '+',
    '(801) 555-0123#',
  ])
    assert.equal(normalizePhone(s), null);
});

test('international + passes through 8–15 digits', () => {
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('+1234567'), null);
});

test('+1 numbers must pass NANP rules even with a plus', () => {
  assert.equal(normalizePhone('+1 911 555 0123'), null);
  assert.equal(normalizePhone('+1 801 155 0123'), null);
});
