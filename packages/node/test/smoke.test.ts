import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, GoToSmsError } from '../src/index.js';

test('exports VERSION and error base class', () => {
  assert.equal(typeof VERSION, 'string');
  assert.ok(new GoToSmsError('x', 'c') instanceof Error);
});

test('the public surface is the facade, stores, errors and helpers; internals stay private', async () => {
  const api = await import('../src/index.js');
  for (const name of [
    'createGoToSms',
    'MemoryStore',
    'FileStore',
    'SqliteStore',
    'normalizePhone',
    'VERSION',
    'GoToSmsError',
    'SendFailedError',
    'NotConfiguredError',
  ]) {
    assert.ok(name in api, `${name} is exported`);
  }
  for (const name of [
    'GoToAuth',
    'Sender',
    'Poller',
    'InboundProcessor',
    'ConfigResolver',
    'SecretBox',
    'MessageLog',
    'OptOuts',
    'enableWebhook',
    'listAccounts',
    'createGoToHttp',
  ]) {
    assert.ok(!(name in api), `${name} is internal`);
  }
});
