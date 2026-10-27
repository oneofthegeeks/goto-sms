import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, GoToSmsError } from '../src/index.js';

test('exports VERSION and error base class', () => {
  assert.equal(typeof VERSION, 'string');
  assert.ok(new GoToSmsError('x', 'c') instanceof Error);
});
