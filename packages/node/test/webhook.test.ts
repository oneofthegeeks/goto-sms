import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGoToHttp } from '../src/http.js';
import { MemoryStore } from '../src/store/memory.js';
import { GoToApiError } from '../src/errors.js';
import {
  checkWebhookSecret,
  disableWebhook,
  enableWebhook,
  parseWebhookEnvelope,
} from '../src/inbound/webhook.js';
import { startFakeGoTo } from './helpers/fake-goto.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const URL_ = 'https://example.test/goto/webhook';

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
  const store = new MemoryStore();
  const opts = {
    http,
    store,
    tenant: 't',
    accountKey: 'acct-1',
    webhookUrl: URL_,
    channelPrefix: 'goto-sms',
  };
  return { fake, http, store, opts };
}

const channelPosts = (fake: { requests: Array<{ method: string; path: string; body: string }> }) =>
  fake.requests.filter(
    (r) => r.method === 'POST' && r.path.startsWith('/notification-channel/v1/channels/'),
  );
const subPosts = (fake: { requests: Array<{ method: string; path: string; body: string }> }) =>
  fake.requests.filter(
    (r) => r.method === 'POST' && r.path.startsWith('/messaging/v2/subscriptions'),
  );

test('C17 creates channel with channelType Webhook when none matches; reuses a matching one', async () => {
  const { fake, opts } = await setup();
  await enableWebhook(opts);
  assert.equal(channelPosts(fake).length, 1);
  assert.match(channelPosts(fake)[0]!.path, /^\/notification-channel\/v1\/channels\/goto-sms-/);
  const sent = JSON.parse(
    fake.requests.find((r) => r.method === 'POST' && r.path.includes('channels/'))!.body,
  );
  assert.deepEqual(sent, {
    channelType: 'Webhook',
    webhookChannelData: { webhook: { url: URL_ } },
  });

  await enableWebhook(opts);
  assert.equal(channelPosts(fake).length, 1, 'matching channel reused');
  assert.equal(fake.channels.length, 1);
});

test('C18 subscription POST has accountKey in query and body; existing matching subscription → no POST', async () => {
  const { fake, store, opts } = await setup();
  const r = await enableWebhook(opts);
  assert.deepEqual(r, { channelId: 'ch-1', subscriptionId: 'sub-1' });
  const post = subPosts(fake)[0]!;
  assert.equal(new URL(post.path, 'http://x').searchParams.get('accountKey'), 'acct-1');
  assert.deepEqual(JSON.parse(post.body), {
    accountKey: 'acct-1',
    ownerEntity: 'acct-1',
    ownerEntityType: 'ACCOUNT',
    channelId: 'ch-1',
    eventTypes: ['INBOUND_MESSAGE'],
  });
  assert.equal(await store.get('t', 'inbound:channelId'), 'ch-1');
  assert.equal(await store.get('t', 'inbound:subscriptionId'), 'sub-1');

  assert.deepEqual(await enableWebhook(opts), r);
  assert.equal(subPosts(fake).length, 1, 'no second POST');
});

test('C18 on 4xx retries with ORGANIZATION', async () => {
  const { fake, opts } = await setup();
  fake.failNext('POST', '/messaging/v2/subscriptions', 400, { error: 'bad owner' });
  await enableWebhook(opts);
  assert.equal(subPosts(fake).length, 2);
  assert.equal(JSON.parse(subPosts(fake)[1]!.body).ownerEntityType, 'ORGANIZATION');
  assert.equal(fake.subscriptions[0]!.ownerEntityType, 'ORGANIZATION');
});

test('C18 a 403 on both shapes carries the GoTo body on GoToApiError', async () => {
  const { fake, opts } = await setup();
  fake.failNext('POST', '/messaging/v2/subscriptions', 403, { error: 'first' });
  fake.failNext('POST', '/messaging/v2/subscriptions', 403, { message: 'missing scope' });
  await assert.rejects(enableWebhook(opts), (e: unknown) => {
    assert.ok(e instanceof GoToApiError);
    assert.equal(e.status, 403);
    assert.match(e.body, /missing scope/);
    return true;
  });
});

test('a 5xx on the first subscription POST is not retried', async () => {
  const { fake, opts } = await setup();
  fake.failNext('POST', '/messaging/v2/subscriptions', 500, {});
  await assert.rejects(enableWebhook(opts), GoToApiError);
  assert.equal(subPosts(fake).length, 1);
});

test('enableWebhook generates the secret once; disableWebhook deletes, clears ids, rotates secret', async () => {
  const { fake, store, opts } = await setup();
  await enableWebhook(opts);
  const secret = await store.get('t', 'inbound:webhookSecret');
  assert.equal(typeof secret, 'string');
  assert.match(secret as string, /^[A-Za-z0-9_-]{43}$/);
  await enableWebhook(opts);
  assert.equal(await store.get('t', 'inbound:webhookSecret'), secret, 'stable across enables');

  await disableWebhook({ http: opts.http, store, tenant: 't' });
  assert.equal(fake.subscriptions.length, 0);
  assert.equal(await store.get('t', 'inbound:channelId'), undefined);
  assert.equal(await store.get('t', 'inbound:subscriptionId'), undefined);
  const rotated = await store.get('t', 'inbound:webhookSecret');
  assert.match(rotated as string, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rotated, secret);
});

test('disableWebhook ignores a 404 and works when never enabled', async () => {
  const { fake, store, opts } = await setup();
  await enableWebhook(opts);
  fake.subscriptions.length = 0; // gone on GoTo's side already
  await disableWebhook({ http: opts.http, store, tenant: 't' });
  assert.equal(await store.get('t', 'inbound:subscriptionId'), undefined);
  await disableWebhook({ http: opts.http, store, tenant: 't' }); // nothing stored: no throw
});

test('disableWebhook propagates a non-404 failure and keeps the ids', async () => {
  const { fake, store, opts } = await setup();
  await enableWebhook(opts);
  fake.failNext('DELETE', '/messaging/v2/subscriptions/', 500, {});
  await assert.rejects(disableWebhook({ http: opts.http, store, tenant: 't' }), GoToApiError);
  assert.equal(await store.get('t', 'inbound:subscriptionId'), 'sub-1');
});

test('C16 parse: party-invites envelope → message', () => {
  const body = {
    type: 'INBOUND_MESSAGE',
    content: {
      payload: {
        id: 'm-1',
        direction: 'INBOUND',
        authorTouchpoint: { phoneNumber: '(801) 555-0123' },
        ownerPhoneNumber: '+18015550199',
        body: '  YES 3  ',
        timestamp: '2026-10-27T10:00:00Z',
      },
    },
  };
  assert.deepEqual(parseWebhookEnvelope(body), {
    id: 'm-1',
    from: '+18015550123',
    to: '+18015550199',
    text: 'YES 3',
    receivedAt: '2026-10-27T10:00:00Z',
    raw: body,
  });
});

test('C16 parse: id falls back to a stable sha256 of from|to|text|timestamp', () => {
  const body = {
    payload: { from: '+18015550123', to: '+18015550199', text: 'hi', timestamp: 'T1' },
  };
  const a = parseWebhookEnvelope(body)!;
  assert.match(a.id, /^[0-9a-f]{64}$/);
  assert.equal(parseWebhookEnvelope(structuredClone(body))!.id, a.id);
  const other = { payload: { ...body.payload, text: 'bye' } };
  assert.notEqual(parseWebhookEnvelope(other)!.id, a.id);
});

test('C16 parse: non-INBOUND_MESSAGE type, outbound direction, and garbage → null, never throws', () => {
  assert.equal(
    parseWebhookEnvelope({
      type: 'OUTBOUND_MESSAGE',
      payload: { from: '+18015550123', body: 'x' },
    }),
    null,
  );
  assert.equal(
    parseWebhookEnvelope({ payload: { direction: 'OUTBOUND', from: '+18015550123', body: 'x' } }),
    null,
  );
  for (const g of [
    null,
    undefined,
    42,
    'str',
    [],
    {},
    { payload: 5 },
    { content: { payload: null } },
    { payload: { from: {}, body: {} } },
    { payload: { from: 'not a phone', body: 'x' } },
    { payload: { from: '+18015550123', body: '   ' } },
  ]) {
    assert.equal(parseWebhookEnvelope(g), null);
  }
});

test('checkWebhookSecret: good, bad, different length', () => {
  assert.equal(checkWebhookSecret('abc123', 'abc123'), true);
  assert.equal(checkWebhookSecret('abc124', 'abc123'), false);
  assert.equal(checkWebhookSecret('abc', 'abc123'), false);
  assert.equal(checkWebhookSecret('', ''), false, 'an empty secret never authenticates');
});
