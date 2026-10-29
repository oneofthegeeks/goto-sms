import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ConfigResolver } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { SecretBox } from '../src/secrets.js';
import { GoToSmsError } from '../src/errors.js';

const T = 't1';
const make = (
  o: {
    store?: MemoryStore;
    box?: SecretBox;
    options?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
  } = {},
) => {
  const store = o.store ?? new MemoryStore();
  const box = o.box ?? new SecretBox(randomBytes(32));
  return {
    store,
    box,
    cfg: new ConfigResolver({
      store,
      tenant: T,
      box,
      options: o.options ?? {},
      env: o.env ?? {},
    }),
  };
};

test('nothing set resolves to all unset', async () => {
  const r = await make().cfg.resolve();
  assert.deepEqual(r.sources, {
    clientId: 'unset',
    clientSecret: 'unset',
    accountKey: 'unset',
    fromNumber: 'unset',
  });
  assert.equal(r.credentialsUnreadable, false);
  assert.equal(r.clientId, undefined);
});

test('option beats env beats store, with sources', async () => {
  const store = new MemoryStore();
  await store.set(T, 'config:clientId', 'from-store');
  await store.set(T, 'config:accountKey', 'acct-store');
  await store.set(T, 'config:fromNumber', '+18015550123');
  const { cfg } = make({
    store,
    options: { clientId: 'from-option' },
    env: { GOTO_CLIENT_ID: 'from-env', GOTO_ACCOUNT_KEY: 'acct-env' },
  });
  const r = await cfg.resolve();
  assert.equal(r.clientId, 'from-option');
  assert.equal(r.sources.clientId, 'options');
  assert.equal(r.accountKey, 'acct-env');
  assert.equal(r.sources.accountKey, 'env');
  assert.equal(r.fromNumber, '+18015550123');
  assert.equal(r.sources.fromNumber, 'store');
  assert.equal(r.sources.clientSecret, 'unset');
});

test('empty-string option and env count as unset', async () => {
  const store = new MemoryStore();
  await store.set(T, 'config:clientId', 'from-store');
  const { cfg } = make({
    store,
    options: { clientId: '' },
    env: { GOTO_CLIENT_ID: '' },
  });
  const r = await cfg.resolve();
  assert.equal(r.clientId, 'from-store');
  assert.equal(r.sources.clientId, 'store');
});

test('fromNumber from env is normalized', async () => {
  const r = await make({ env: { GOTO_FROM_NUMBER: '(801) 555-0123' } }).cfg.resolve();
  assert.equal(r.fromNumber, '+18015550123');
  assert.equal(r.invalidFromNumber, undefined);
});

test('invalid env fromNumber: undefined value, source kept, invalidFromNumber flagged', async () => {
  const r = await make({ env: { GOTO_FROM_NUMBER: 'nope' } }).cfg.resolve();
  assert.equal(r.fromNumber, undefined);
  assert.equal(r.sources.fromNumber, 'env');
  assert.equal(r.invalidFromNumber, true);
});

test('save stores plain fields and a sealed secret', async () => {
  const { cfg, store } = make();
  await cfg.save({
    clientId: 'cid',
    clientSecret: 'super-secret-value',
    accountKey: 'ak',
    fromNumber: '801 555 0123',
  });
  assert.equal(await store.get(T, 'config:clientId'), 'cid');
  assert.equal(await store.get(T, 'config:fromNumber'), '+18015550123');
  const raw = await store.get(T, 'config:clientSecret');
  assert.equal(typeof raw, 'string');
  assert.ok(!(raw as string).includes('super-secret-value'));
  const r = await cfg.resolve();
  assert.equal(r.clientSecret, 'super-secret-value');
  assert.equal(r.sources.clientSecret, 'store');
});

test('blank clientSecret save keeps the stored value', async () => {
  const { cfg } = make();
  await cfg.save({ clientSecret: 'keepme' });
  await cfg.save({ clientSecret: '', clientId: 'new-id' });
  const r = await cfg.resolve();
  assert.equal(r.clientSecret, 'keepme');
  assert.equal(r.clientId, 'new-id');
});

test('save of an env- or option-set field throws locked, naming the field', async () => {
  const { cfg } = make({ env: { GOTO_CLIENT_ID: 'x' }, options: { accountKey: 'y' } });
  await assert.rejects(
    cfg.save({ clientId: 'z' }),
    (e: unknown) =>
      e instanceof GoToSmsError &&
      e.code === 'locked' &&
      e.message === "clientId is set by config (env) and can't be changed here",
  );
  await assert.rejects(
    cfg.save({ accountKey: 'z' }),
    (e: unknown) => e instanceof GoToSmsError && e.code === 'locked' && /options/.test(e.message),
  );
});

test('a patch with one locked field writes nothing', async () => {
  const { cfg, store } = make({ env: { GOTO_CLIENT_ID: 'x' } });
  await assert.rejects(cfg.save({ accountKey: 'ak', clientId: 'z' }), { code: 'locked' });
  assert.equal(await store.get(T, 'config:accountKey'), undefined);
});

test('a blank value for a locked field is skipped, not a conflict', async () => {
  const { cfg, store } = make({ env: { GOTO_CLIENT_ID: 'x' } });
  await cfg.save({ clientId: '', accountKey: 'ak' });
  assert.equal(await store.get(T, 'config:accountKey'), 'ak');
  assert.equal((await cfg.resolve()).clientId, 'x');
});

test('a patch with an invalid fromNumber throws invalid_number and writes nothing', async () => {
  const { cfg, store } = make();
  await assert.rejects(cfg.save({ clientId: 'cid', fromNumber: 'abc' }), {
    code: 'invalid_number',
  });
  assert.equal(await store.get(T, 'config:clientId'), undefined);
});

test('secret sealed with key A and resolved with key B is unreadable, not a throw', async () => {
  const store = new MemoryStore();
  const a = make({ store });
  await a.cfg.save({ clientId: 'cid', clientSecret: 'sekret' });
  const b = make({ store });
  const r = await b.cfg.resolve();
  assert.equal(r.credentialsUnreadable, true);
  assert.equal(r.clientSecret, undefined);
  assert.equal(r.clientId, 'cid');
});

test('non-decrypt errors from the box are rethrown', async () => {
  const store = new MemoryStore();
  const box = new SecretBox(randomBytes(32));
  await store.set(T, 'config:clientSecret', box.seal('x'));
  const boom = {
    seal: box.seal.bind(box),
    open: () => {
      throw new TypeError('boom');
    },
  } as unknown as SecretBox;
  const cfg = new ConfigResolver({ store, tenant: T, box: boom, options: {}, env: {} });
  await assert.rejects(cfg.resolve(), TypeError);
});

test('seedRefreshToken prefers the option, then env, ignoring blanks', () => {
  assert.equal(
    make({
      options: { refreshToken: 'o' },
      env: { GOTO_REFRESH_TOKEN: 'e' },
    }).cfg.seedRefreshToken(),
    'o',
  );
  assert.equal(make({ env: { GOTO_REFRESH_TOKEN: 'e' } }).cfg.seedRefreshToken(), 'e');
  assert.equal(
    make({ options: { refreshToken: '' }, env: { GOTO_REFRESH_TOKEN: '' } }).cfg.seedRefreshToken(),
    undefined,
  );
});

test('blank and CHANGEME values count as unset, in options and env', async () => {
  const store = new MemoryStore();
  await store.set(T, 'config:clientId', 'from-store');
  const { cfg } = make({
    store,
    options: { clientId: 'CHANGEME', accountKey: '   ' },
    env: { GOTO_CLIENT_ID: ' changeme ', GOTO_ACCOUNT_KEY: '\t', GOTO_CLIENT_SECRET: 'ChangeMe' },
  });
  const r = await cfg.resolve();
  assert.equal(r.clientId, 'from-store');
  assert.equal(r.sources.clientId, 'store');
  assert.equal(r.sources.accountKey, 'unset');
  assert.equal(r.sources.clientSecret, 'unset');
  // A placeholder isn't "set by config", so the setup page can save a real value.
  await cfg.save({ clientId: 'real-id' });
  assert.equal((await cfg.resolve()).clientId, 'real-id');
});

test('real values are kept untrimmed', async () => {
  const r = await make({ env: { GOTO_CLIENT_ID: ' id-with-spaces ' } }).cfg.resolve();
  assert.equal(r.clientId, ' id-with-spaces ');
});

test('seedRefreshToken ignores a CHANGEME placeholder', () => {
  assert.equal(
    make({
      options: { refreshToken: 'CHANGEME' },
      env: { GOTO_REFRESH_TOKEN: 'e' },
    }).cfg.seedRefreshToken(),
    'e',
  );
  assert.equal(make({ env: { GOTO_REFRESH_TOKEN: 'changeme' } }).cfg.seedRefreshToken(), undefined);
});
