import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGoToHttp } from '../src/http.js';
import { listAccounts, listNumbers } from '../src/directory.js';
import { startFakeGoTo } from './helpers/fake-goto.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  fake.tokens.valid.add('tok');
  const http = createGoToHttp({
    apiBaseUrl: fake.url,
    fetch,
    getToken: async () => 'tok',
    forceRefresh: async () => 'tok',
  });
  return { fake, http };
}

const EXT = 'urn:scim:schemas:extension:getgo:1.0';

test('C6 accounts from urn:scim:schemas:extension:getgo:1.0.accounts[] (value→key, display→name)', async () => {
  const { fake, http } = await setup();
  fake.me = {
    [EXT]: { accounts: [{ value: 'a1', display: 'Acme' }, { value: 'a2' }, { display: 'no key' }] },
  };
  assert.deepEqual(await listAccounts(http), [
    { key: 'a1', name: 'Acme' },
    { key: 'a2', name: 'a2' }, // display missing: falls back to the key
  ]);
});

test('C6 a missing extension gives []', async () => {
  const { fake, http } = await setup();
  fake.me = {};
  assert.deepEqual(await listAccounts(http), []);
});

test('C7 numbers follow pageMarker across 3 pages and dedupe by number', async () => {
  const { fake, http } = await setup();
  fake.numbersPages = [
    [{ number: '+18015550101' }, { number: '+18015550102' }],
    [{ number: '+18015550102' }, { number: '+18015550103' }], // 0102 repeats
    [{ number: '+18015550104' }],
  ];
  const numbers = await listNumbers(http, 'acct-1');
  assert.deepEqual(
    numbers.map((n) => n.number),
    ['+18015550101', '+18015550102', '+18015550103', '+18015550104'],
  );
  const calls = fake.requests.filter((r) => r.path.startsWith('/voice-admin/'));
  assert.equal(calls.length, 3);
  assert.ok(
    calls[0]!.path.includes('accountKey=acct-1') && calls[0]!.path.includes('pageSize=100'),
  );
  assert.ok(!calls[0]!.path.includes('pageMarker'));
  assert.ok(calls[2]!.path.includes('pageMarker=2'));
});

test('numbers are normalized to E.164, smsEnabled passes through, bad numbers are skipped', async () => {
  const { fake, http } = await setup();
  fake.numbersPages = [
    [
      { number: '(801) 555-0101', name: 'Main', smsEnabled: true },
      { number: '801-555-0102', callerIdName: 'Front desk', smsEnabled: false },
      { number: '801-555-0103' },
      { number: 'garbage' },
      {},
    ],
  ];
  assert.deepEqual(await listNumbers(http, 'acct-1'), [
    { number: '+18015550101', name: 'Main', accountKey: 'acct-1', smsEnabled: true },
    { number: '+18015550102', name: 'Front desk', accountKey: 'acct-1', smsEnabled: false },
    { number: '+18015550103', name: '', accountKey: 'acct-1' },
  ]);
});

test('hitting the 50-page cap returns what was collected', async () => {
  const { fake, http } = await setup();
  fake.numbersPages = Array.from({ length: 60 }, (_, i) => [
    { number: `+1801555${String(1000 + i)}` },
  ]);
  assert.equal((await listNumbers(http, 'acct-1')).length, 50);
});
