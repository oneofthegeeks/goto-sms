// The setup page's status payload. One builder for both GET /api/status and sms.status().
// Type-only imports from client.ts, so there is no runtime import cycle.
import type { Core, IncomingMode, ResolvedOptions } from '../client.js';
import type { ConfigField, Source } from '../config.js';
import { getWebhookSecret } from '../inbound/webhook.js';
import { VERSION } from '../types.js';

/** Scopes the admin must tick on their GoTo OAuth client (shown on the setup page). */
export const REQUIRED_SCOPES = [
  'messaging.v1.send',
  'messaging.v1.read',
  'messaging.v1.notifications.manage',
  'voice-admin.v1.read',
];

/**
 * Never carries the client secret, tokens or the refresh token (C22). The webhook secret
 * appears only inside `incoming.webhookUrl`, which the authorized admin needs to see.
 */
export interface StatusPayload {
  version: string;
  /** A readable client ID and client secret are available. */
  configured: boolean;
  connected: boolean;
  loginExpired: boolean;
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
    webhookUrl?: string;
    /** publicUrl is https. */
    canWebhook: boolean;
  };
  requiredScopes: string[];
}

const UNSET: Record<ConfigField, Source> = {
  clientId: 'unset',
  clientSecret: 'unset',
  accountKey: 'unset',
  fromNumber: 'unset',
};

/** Without a core (startup failed for lack of configuration) everything reads as not set up. */
export async function buildStatus(options: ResolvedOptions, core?: Core): Promise<StatusPayload> {
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
    };
  }

  const auth = await core.auth.status();
  const r = await core.config.resolve();
  const mode = await core.incomingMode();
  const secret = mode === 'webhook' ? await getWebhookSecret(core.store, core.tenant) : undefined;
  const webhookUrl = secret ? core.webhookUrl(secret) : undefined;
  const configured = Boolean(r.clientId && r.clientSecret) && !r.credentialsUnreadable;
  return {
    ...base,
    configured,
    connected: auth.connected,
    loginExpired: auth.loginExpired,
    credentialsUnreadable: r.credentialsUnreadable,
    ready: configured && auth.connected && r.fromNumber !== undefined,
    ...(r.clientId !== undefined ? { clientId: r.clientId } : {}),
    ...(r.accountKey !== undefined ? { accountKey: r.accountKey } : {}),
    ...(r.fromNumber !== undefined ? { fromNumber: r.fromNumber } : {}),
    ...(r.invalidFromNumber ? { invalidFromNumber: true as const } : {}),
    sources: r.sources,
    ...(auth.refreshSource ? { refreshSource: auth.refreshSource } : {}),
    incoming: { mode, ...(webhookUrl ? { webhookUrl } : {}), canWebhook },
  };
}
