// Webhook setup (notification channel + messaging subscription) and tolerant parsing of
// GoTo's inbound envelope. Ported from party-invites (sms.js subscribeInbound,
// features/inbound.js parseEnvelope). Nothing here logs: bodies hold phone numbers/text.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { GoToApiError } from '../errors.js';
import type { GoToHttp } from '../http.js';
import { normalizePhone } from '../phone.js';
import type { GoToSmsStore } from '../store/types.js';
import type { InboundMessage } from '../types.js';

const CHANNELS = '/notification-channel/v1/channels';
const SUBSCRIPTIONS = '/messaging/v2/subscriptions';
const EVENT = 'INBOUND_MESSAGE';
const MAX_TEXT = 500;

const KEY_SECRET = 'inbound:webhookSecret';
const KEY_CHANNEL = 'inbound:channelId';
const KEY_SUBSCRIPTION = 'inbound:subscriptionId';
const KEY_ACCOUNT = 'inbound:accountKey';

interface Channel {
  channelId?: string;
  webhookChannelData?: { webhook?: { url?: string } };
}
interface Subscription {
  id?: string;
  channelId?: string;
  eventTypes?: string[];
}

const newSecret = () => randomBytes(32).toString('base64url');

/**
 * Make sure GoTo has a Webhook channel pointing at `webhookUrl` and an INBOUND_MESSAGE
 * subscription on `accountKey` for it, reusing whatever already matches. Stores the ids
 * (and the webhook secret, if absent). A 403 surfaces as GoToApiError with GoTo's body.
 */
export async function enableWebhook(o: {
  http: GoToHttp;
  store: GoToSmsStore;
  tenant: string;
  accountKey: string;
  webhookUrl: string;
  channelPrefix: string;
}): Promise<{ channelId: string; subscriptionId: string }> {
  if (!o.accountKey) throw new Error('accountKey is required to subscribe to inbound texts');
  const query = { accountKey: o.accountKey };

  const list = await o.http.json<{ items?: Channel[] }>('GET', CHANNELS);
  let channel = (list.items ?? []).find((c) => c.webhookChannelData?.webhook?.url === o.webhookUrl);
  if (!channel) {
    channel = await o.http.json<Channel>(
      'POST',
      `${CHANNELS}/${o.channelPrefix}-${Date.now().toString(36)}`,
      { channelType: 'Webhook', webhookChannelData: { webhook: { url: o.webhookUrl } } },
    );
  }
  const channelId = channel.channelId;
  if (!channelId) throw new Error('GoTo made no notification channel (no channelId in the answer)');

  const have = await o.http.json<{ items?: Subscription[] }>('GET', SUBSCRIPTIONS, undefined, {
    query,
  });
  let sub = (have.items ?? []).find(
    (s) => s.channelId === channelId && (s.eventTypes ?? []).includes(EVENT),
  );
  if (!sub) {
    const create = (ownerEntityType: 'ACCOUNT' | 'ORGANIZATION') =>
      o.http.json<Subscription>(
        'POST',
        SUBSCRIPTIONS,
        {
          accountKey: o.accountKey,
          ownerEntity: o.accountKey,
          ownerEntityType,
          channelId,
          eventTypes: [EVENT],
        },
        { query },
      );
    try {
      sub = await create('ACCOUNT');
    } catch (err) {
      // GoTo's guide shows the organization as owner; try that shape on a 4xx before giving up.
      if (!(err instanceof GoToApiError) || err.status < 400 || err.status >= 500) throw err;
      sub = await create('ORGANIZATION');
    }
  }
  const subscriptionId = sub.id;
  if (!subscriptionId) throw new Error('GoTo made no subscription (no id in the answer)');

  await o.store.set(o.tenant, KEY_CHANNEL, channelId);
  await o.store.set(o.tenant, KEY_SUBSCRIPTION, subscriptionId);
  await o.store.set(o.tenant, KEY_ACCOUNT, o.accountKey);
  if ((await o.store.get(o.tenant, KEY_SECRET)) === undefined) {
    await o.store.set(o.tenant, KEY_SECRET, newSecret());
  }
  return { channelId, subscriptionId };
}

/**
 * Delete the stored subscription (a 404 means it's already gone), clear the stored ids and
 * rotate the webhook secret so the old webhook URL stops authenticating. A failed DELETE
 * throws and leaves everything as it was, so disable can be retried.
 */
export async function disableWebhook(o: {
  http: GoToHttp;
  store: GoToSmsStore;
  tenant: string;
}): Promise<void> {
  const subscriptionId = await o.store.get(o.tenant, KEY_SUBSCRIPTION);
  const accountKey = await o.store.get(o.tenant, KEY_ACCOUNT);
  if (typeof subscriptionId === 'string') {
    try {
      await o.http.json(
        'DELETE',
        `${SUBSCRIPTIONS}/${encodeURIComponent(subscriptionId)}`,
        undefined,
        typeof accountKey === 'string' ? { query: { accountKey } } : {},
      );
    } catch (err) {
      if (!(err instanceof GoToApiError && err.status === 404)) throw err;
    }
  }
  await o.store.delete(o.tenant, KEY_CHANNEL);
  await o.store.delete(o.tenant, KEY_SUBSCRIPTION);
  await o.store.delete(o.tenant, KEY_ACCOUNT);
  await o.store.set(o.tenant, KEY_SECRET, newSecret());
}

/** Constant-time compare; false on length mismatch, and an empty secret never matches. */
export function checkWebhookSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A number from a string or a touchpoint-like object ({phoneNumber|number|value|id}). */
function pick(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!isObject(v)) return '';
  for (const k of ['phoneNumber', 'number', 'value', 'id']) {
    if (typeof v[k] === 'string' && v[k]) return v[k];
  }
  return '';
}

/**
 * Tolerant parse of a GoTo webhook body. Returns null for anything that isn't an inbound
 * text with a usable sender and body; never throws. The id is GoTo's, else a stable hash so
 * a redelivery dedupes. Not persisted here (the caller does that).
 */
export function parseWebhookEnvelope(body: unknown): Omit<InboundMessage, 'keyword'> | null {
  if (!isObject(body)) return null;
  if (body.type && body.type !== EVENT) return null;
  const content = isObject(body.content) ? body.content : undefined;
  const p = [content?.payload, body.payload, body.data, body].find(isObject);
  if (!p) return null;
  if (p.direction && p.direction !== 'INBOUND') return null;

  const contacts = Array.isArray(p.contactTouchpoints) ? p.contactTouchpoints : [];
  const fromRaw =
    pick(p.authorTouchpoint) || pick(p.from) || pick(p.contactPhoneNumber) || pick(contacts[0]);
  const from = normalizePhone(fromRaw);
  const rawText = p.body ?? p.text ?? p.message ?? '';
  const text = (typeof rawText === 'string' ? rawText : '').trim().slice(0, MAX_TEXT);
  if (!from || !text) return null;

  const toRaw = pick(p.ownerPhoneNumber) || pick(p.to) || pick(p.ownerTouchpoint);
  const to = normalizePhone(toRaw) ?? toRaw;
  const stamp = [p.timestamp, p.createdAt, body.timestamp].find((t) => typeof t === 'string' && t);
  const timestamp = typeof stamp === 'string' ? stamp : '';
  const id =
    typeof p.id === 'string' && p.id
      ? p.id
      : createHash('sha256').update(`${from}|${to}|${text}|${timestamp}`).digest('hex');
  return {
    id,
    from,
    to,
    text,
    receivedAt: timestamp || new Date().toISOString(),
    raw: body,
  };
}
