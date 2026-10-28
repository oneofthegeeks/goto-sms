// The setup page's status payload. One builder for both GET /api/status and sms.status().
// Type-only imports from client.ts, so there is no runtime import cycle.
import type { Core, IncomingMode, ResolvedOptions } from '../client.js';
import type { ConfigField, Source } from '../config.js';
import { GoToSmsError } from '../errors.js';
import { errorName } from '../http.js';
import { getWebhookSecret } from '../inbound/webhook.js';
import { VERSION } from '../types.js';

/** Scopes the admin must tick on their GoTo OAuth client (shown on the setup page). */
export const REQUIRED_SCOPES = [
  'messaging.v1.send',
  'messaging.v1.read',
  'messaging.v1.notifications.manage',
  'voice-admin.v1.read',
];

/** Store key: why moving the webhook to a newly selected account failed (`incoming.error`). */
export const INBOUND_ERROR = 'inbound:error';

/** A failed webhook re-subscribe: the package error code and GoTo's HTTP status, no body. */
export interface IncomingError {
  error: string;
  message: string;
  gotoStatus?: number;
}

/**
 * Never carries the client secret, tokens or the refresh token (C22). The webhook secret
 * appears only inside `incoming.webhookUrl`, which only the authorized GET /api/status
 * includes; programmatic `sms.status()` omits it (R30).
 */
export interface StatusPayload {
  version: string;
  /** A readable client ID and client secret are available. */
  configured: boolean;
  connected: boolean;
  loginExpired: boolean;
  /** The stored client secret or GoTo login can't be decrypted (the encryption key changed). */
  credentialsUnreadable: boolean;
  /** Configured, connected and a sending number chosen: sends can go out. */
  ready: boolean;
  clientId?: string;
  accountKey?: string;
  fromNumber?: string;
  /** An options/env fromNumber isn't a valid phone number. */
  invalidFromNumber?: true;
  sources: Record<ConfigField, Source>;
  refreshSource?: 'login' | 'seeded-from-env';
  /** '' when no publicUrl is configured. */
  redirectUri: string;
  incoming: {
    mode: IncomingMode;
    /** Only in GET /api/status (behind authorize), never from sms.status(): it holds the secret. */
    webhookUrl?: string;
    /** publicUrl is https. */
    canWebhook: boolean;
    /**
     * Set when the account changed in webhook mode and moving the subscription failed:
     * texts to the selected account aren't arriving. Cleared by a successful mode switch or a
     * successful move to the account (including the page's retry).
     */
    error?: IncomingError;
  };
  requiredScopes: string[];
  /** Why startup failed (e.g. no encryption key), when it did. Secret-free. */
  startupError?: string;
}

/**
 * A secret-free description of a startup failure. Package errors carry fixed messages;
 * anything else is named only, since its message could hold a path or a value.
 */
export function startupErrorText(err: unknown): string {
  return err instanceof GoToSmsError
    ? err.message
    : `goto-sms failed to start (${errorName(err)}); see the server logs`;
}

function asIncomingError(v: unknown): IncomingError | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.error !== 'string' || typeof o.message !== 'string') return undefined;
  return {
    error: o.error,
    message: o.message,
    ...(typeof o.gotoStatus === 'number' ? { gotoStatus: o.gotoStatus } : {}),
  };
}

const UNSET: Record<ConfigField, Source> = {
  clientId: 'unset',
  clientSecret: 'unset',
  accountKey: 'unset',
  fromNumber: 'unset',
};

/**
 * Without a core (startup failed, e.g. for lack of configuration) everything reads as not set
 * up, with `startupError` saying why. `includeWebhookUrl` is for the authorized HTTP route
 * only; off by default so no other caller can leak the webhook secret.
 */
export async function buildStatus(
  options: ResolvedOptions,
  core?: Core,
  startupError?: string,
  o: { includeWebhookUrl?: boolean } = {},
): Promise<StatusPayload> {
  const base = {
    version: VERSION,
    redirectUri: options.redirectUri ?? '',
    requiredScopes: [...REQUIRED_SCOPES],
  };
  const canWebhook = options.publicUrl?.startsWith('https://') ?? false;
  if (!core) {
    return {
      ...base,
      configured: false,
      connected: false,
      loginExpired: false,
      credentialsUnreadable: false,
      ready: false,
      sources: { ...UNSET },
      incoming: { mode: 'off', canWebhook },
      ...(startupError ? { startupError } : {}),
    };
  }

  const auth = await core.auth.status();
  const r = await core.config.resolve();
  const mode = await core.incomingMode();
  const secret =
    o.includeWebhookUrl && mode === 'webhook'
      ? await getWebhookSecret(core.store, core.tenant)
      : undefined;
  const webhookUrl = secret ? core.webhookUrl(secret) : undefined;
  const configured = Boolean(r.clientId && r.clientSecret) && !r.credentialsUnreadable;
  const error = asIncomingError(await core.store.get(core.tenant, INBOUND_ERROR));
  return {
    ...base,
    configured,
    connected: auth.connected,
    loginExpired: auth.loginExpired,
    credentialsUnreadable: r.credentialsUnreadable || auth.tokensUnreadable === true,
    ready: configured && auth.connected && r.fromNumber !== undefined,
    ...(r.clientId !== undefined ? { clientId: r.clientId } : {}),
    ...(r.accountKey !== undefined ? { accountKey: r.accountKey } : {}),
    ...(r.fromNumber !== undefined ? { fromNumber: r.fromNumber } : {}),
    ...(r.invalidFromNumber ? { invalidFromNumber: true as const } : {}),
    sources: r.sources,
    ...(auth.refreshSource ? { refreshSource: auth.refreshSource } : {}),
    incoming: {
      mode,
      ...(webhookUrl ? { webhookUrl } : {}),
      canWebhook,
      ...(error ? { error } : {}),
    },
  };
}
