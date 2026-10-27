import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DecryptError,
  GoToApiError,
  GoToSmsError,
  LoginExpiredError,
  NotConfiguredError,
  TemporaryError,
} from './errors.js';
import { errorName } from './http.js';
import type { ConfigResolver } from './config.js';
import type { SecretBox } from './secrets.js';
import type { GoToSmsStore, Json } from './store/types.js';
import type { FetchLike, Logger } from './types.js';

const STATE_TTL_MS = 10 * 60_000;
const REUSE_MARGIN_MS = 60_000; // refresh once the access token is within 60 s of expiry
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EXPIRES_IN_S = 3600;
const STATE_PREFIX = 'state:';
// 32 random bytes as base64url, unpadded.
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const SEED_REFUSED =
  'GoTo refused GOTO_REFRESH_TOKEN; set a new one or connect from the setup page';
const NOT_CONNECTED = 'Not connected to GoTo — open the setup page and click Connect';

type RefreshSource = 'login' | 'seeded-from-env';

/** Store key `tokens`. access/refresh are SecretBox-sealed; expiresAt is the real expiry. */
interface TokenRecord {
  access: string;
  refresh: string;
  expiresAt: number;
  source: RefreshSource;
  /** sha256 hex of the GOTO_REFRESH_TOKEN this login came from (or last tried). */
  seedHash?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

/** ' (error: invalid_request)' from an OAuth error body, or '' when absent or odd-looking. */
function oauthError(text: string): string {
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error;
    return typeof e === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(e) ? ` (error: ${e})` : '';
  } catch {
    return '';
  }
}

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function asTokenRecord(v: Json | undefined): TokenRecord | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const { access, refresh, expiresAt, source, seedHash } = v;
  if (typeof access !== 'string' || typeof refresh !== 'string') return undefined;
  if (typeof expiresAt !== 'number') return undefined;
  if (source !== 'login' && source !== 'seeded-from-env') return undefined;
  return {
    access,
    refresh,
    expiresAt,
    source,
    ...(typeof seedHash === 'string' ? { seedHash } : {}),
  };
}

/**
 * GoTo OAuth (authorization-code login + refresh). All state lives in the store, so a
 * restart between Connect and the callback still works. Refreshes are single-flight per
 * instance because GoTo may rotate the refresh token: a second concurrent refresh with
 * the old one would be refused and look like a dead login.
 */
export class GoToAuth {
  private readonly store: GoToSmsStore;
  private readonly tenant: string;
  private readonly box: SecretBox;
  private readonly config: ConfigResolver;
  private readonly fetch: FetchLike;
  private readonly authBaseUrl: string;
  private readonly redirectUri: string;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  /** The in-flight refresh/seed; every concurrent caller awaits this same promise. */
  private inFlight: Promise<string> | undefined;
  /**
   * Hashes of env seeds GoTo refused while no tokens were stored. In memory on purpose
   * (ruling R12): env only changes on restart, so this fails fast for the rest of the
   * process, while a restart with a different seed is tried normally. The cost is one
   * token call per process start while a bad seed stays configured.
   */
  private readonly refusedSeeds = new Set<string>();

  constructor(o: {
    store: GoToSmsStore;
    tenant: string;
    box: SecretBox;
    config: ConfigResolver;
    fetch: FetchLike;
    authBaseUrl: string;
    redirectUri: string;
    now: () => number;
    logger: Logger;
    /** Token-call timeout; default 10 000 ms. */
    timeoutMs?: number;
  }) {
    this.store = o.store;
    this.tenant = o.tenant;
    this.box = o.box;
    this.config = o.config;
    this.fetch = o.fetch;
    this.authBaseUrl = o.authBaseUrl;
    this.redirectUri = o.redirectUri;
    this.now = o.now;
    this.logger = o.logger;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Returns the GoTo authorize URL and saves its state for the callback. */
  async startConnect(): Promise<string> {
    const { clientId } = await this.credentials();
    // Sweep expired states so abandoned logins don't pile up in the store.
    for (const { key, value } of await this.store.list(this.tenant, STATE_PREFIX)) {
      if (this.stateExpired(value)) await this.store.delete(this.tenant, key);
    }
    const state = randomBytes(32).toString('base64url');
    await this.store.set(this.tenant, STATE_PREFIX + state, {
      expiresAt: this.now() + STATE_TTL_MS,
    });
    // No scope and no prompt: GoTo uses the client's configured scopes, and naming
    // one has broken its login page (C1).
    const q = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      state,
    });
    return `${this.authBaseUrl}/oauth/authorize?${q.toString()}`;
  }

  /** Completes the login from the OAuth callback. */
  async finishConnect(code: string, state: string): Promise<void> {
    await this.consumeState(state);
    const creds = await this.credentials();
    // A refused code is LoginExpiredError, but it doesn't touch an existing login.
    const t = await this.tokenRequest(
      { grant_type: 'authorization_code', code, redirect_uri: this.redirectUri },
      creds,
    );
    if (!t.refresh_token) {
      throw new GoToApiError(200, 'GoTo returned no refresh token for the login', {
        tokenEndpoint: true,
      });
    }
    // A plain set: a fresh login replaces whatever was there. An in-flight refresh will
    // lose its compareAndSet and pick these tokens up instead.
    await this.store.set(
      this.tenant,
      'tokens',
      this.record(t, this.box.seal(t.refresh_token), 'login') as unknown as Json,
    );
    await this.store.delete(this.tenant, 'login_expired');
    this.logger.debug('goto-sms: connected to GoTo');
  }

  async getAccessToken(): Promise<string> {
    await this.credentials();
    const tokens = await this.readTokens();
    const seed = this.config.seedRefreshToken();
    const seedHash = seed === undefined ? undefined : sha256hex(seed);

    // The operator put a different GOTO_REFRESH_TOKEN in env than the one these tokens
    // came from (or last tried): re-seed. This is also how a dead seeded login recovers.
    if (seed && seedHash && tokens?.seedHash && tokens.seedHash !== seedHash) {
      return this.exclusive(() => this.seedFlight(seed, seedHash));
    }
    if (!tokens) {
      if (!seed || !seedHash) throw new NotConfiguredError(NOT_CONNECTED);
      if (this.refusedSeeds.has(seedHash)) throw new LoginExpiredError(SEED_REFUSED);
      return this.exclusive(() => this.seedFlight(seed, seedHash));
    }
    if (await this.loginExpired()) throw new LoginExpiredError();
    if (this.fresh(tokens)) return this.openToken(tokens.access);
    return this.exclusive(() => this.refreshFlight(false));
  }

  /** Refresh now even if the access token looks fresh (GoTo answered 401). */
  async forceRefresh(): Promise<string> {
    await this.credentials();
    if (await this.loginExpired()) throw new LoginExpiredError();
    return this.exclusive(() => this.refreshFlight(true));
  }

  async disconnect(): Promise<void> {
    await this.store.delete(this.tenant, 'tokens');
    await this.store.delete(this.tenant, 'login_expired');
    this.logger.debug('goto-sms: disconnected from GoTo');
  }

  async status(): Promise<{
    connected: boolean;
    loginExpired: boolean;
    refreshSource?: RefreshSource;
  }> {
    const tokens = await this.readTokens();
    const loginExpired = await this.loginExpired();
    return {
      connected: tokens !== undefined && !loginExpired,
      loginExpired,
      ...(tokens ? { refreshSource: tokens.source } : {}),
    };
  }

  // --- internals ---

  private exclusive(task: () => Promise<string>): Promise<string> {
    // Store the .finally() promise itself so callers await it and a rejection is never
    // left unhandled on a dropped branch.
    this.inFlight ??= task().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refreshFlight(force: boolean): Promise<string> {
    // Re-read inside the flight: a caller may have seen tokens that a just-finished
    // refresh already replaced, and using a rotated-away refresh token would be refused.
    const prev = await this.readTokens();
    if (!prev) throw new NotConfiguredError(NOT_CONNECTED);
    if (!force && this.fresh(prev)) return this.openToken(prev.access);
    const creds = await this.credentials();
    let t: TokenResponse;
    try {
      t = await this.tokenRequest(
        { grant_type: 'refresh_token', refresh_token: this.openToken(prev.refresh) },
        creds,
      );
    } catch (err) {
      if (err instanceof LoginExpiredError) await this.markLoginExpired();
      throw err;
    }
    // GoTo may or may not rotate the refresh token; keep the old one when it doesn't.
    const next = this.record(
      t,
      t.refresh_token ? this.box.seal(t.refresh_token) : prev.refresh,
      prev.source,
      prev.seedHash,
    );
    const won = await this.commit(prev, next);
    if (won) this.logger.debug('goto-sms: refreshed GoTo access token');
    return won ? t.access_token : this.currentAccess();
  }

  private async seedFlight(seed: string, seedHash: string): Promise<string> {
    const prev = await this.readTokens();
    // A concurrent caller already seeded from this exact token.
    if (prev?.seedHash === seedHash) return this.refreshFlight(false);
    const creds = await this.credentials();
    let t: TokenResponse;
    try {
      t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: seed }, creds);
    } catch (err) {
      if (!(err instanceof LoginExpiredError)) throw err;
      // A refused seed never sets login_expired (ruling R12): it says nothing about
      // the login we already hold, if any.
      if (!prev) {
        this.refusedSeeds.add(seedHash);
        throw new LoginExpiredError(SEED_REFUSED);
      }
      // Record the seed as tried on the existing tokens, so this same bad seed isn't
      // retried on every call, then keep serving the existing login.
      await this.commit(prev, { ...prev, seedHash });
      this.logger.warn(
        'GOTO_REFRESH_TOKEN changed but GoTo refused it; keeping the existing login',
      );
      if (await this.loginExpired()) throw new LoginExpiredError();
      return this.refreshFlight(false);
    }
    const next = this.record(
      t,
      this.box.seal(t.refresh_token ?? seed),
      'seeded-from-env',
      seedHash,
    );
    if (!(await this.commit(prev, next))) return this.currentAccess();
    await this.store.delete(this.tenant, 'login_expired');
    this.logger.debug('goto-sms: seeded GoTo login from GOTO_REFRESH_TOKEN');
    return t.access_token;
  }

  /**
   * Write `next` only if `tokens` is still what this refresh started from. Losing means
   * another writer got there first (a finishConnect, a disconnect, or another process on
   * a shared store); its tokens are newer than ours, so callers use those instead.
   */
  private commit(prev: TokenRecord | undefined, next: TokenRecord): Promise<boolean> {
    return this.store.compareAndSet(
      this.tenant,
      'tokens',
      prev as unknown as Json | undefined,
      next as unknown as Json,
    );
  }

  private async currentAccess(): Promise<string> {
    const current = await this.readTokens();
    if (!current) throw new NotConfiguredError(NOT_CONNECTED);
    return this.openToken(current.access);
  }

  private record(
    t: TokenResponse,
    sealedRefresh: string,
    source: RefreshSource,
    seedHash?: string,
  ): TokenRecord {
    return {
      access: this.box.seal(t.access_token),
      refresh: sealedRefresh,
      expiresAt: this.now() + (t.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1000,
      source,
      ...(seedHash ? { seedHash } : {}),
    };
  }

  private fresh(t: TokenRecord): boolean {
    return this.now() < t.expiresAt - REUSE_MARGIN_MS;
  }

  private async markLoginExpired(): Promise<void> {
    await this.store.set(this.tenant, 'login_expired', true);
    this.logger.debug('goto-sms: GoTo refused the refresh token; login marked expired');
  }

  private async loginExpired(): Promise<boolean> {
    return (await this.store.get(this.tenant, 'login_expired')) === true;
  }

  private async readTokens(): Promise<TokenRecord | undefined> {
    return asTokenRecord(await this.store.get(this.tenant, 'tokens'));
  }

  private openToken(sealed: string): string {
    try {
      return this.box.open(sealed);
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
      throw new NotConfiguredError("Saved GoTo login can't be decrypted — reconnect to GoTo");
    }
  }

  private async credentials(): Promise<{ clientId: string; clientSecret: string }> {
    const c = await this.config.resolve();
    if (c.credentialsUnreadable) {
      throw new NotConfiguredError(
        "Saved GoTo credentials can't be decrypted — re-enter the client secret and reconnect",
      );
    }
    if (!c.clientId || !c.clientSecret) {
      throw new NotConfiguredError('GoTo client ID and client secret are not set');
    }
    return { clientId: c.clientId, clientSecret: c.clientSecret };
  }

  private stateExpired(value: Json | undefined): boolean {
    const expiresAt =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value.expiresAt
        : undefined;
    return typeof expiresAt !== 'number' || this.now() >= expiresAt;
  }

  /** Single use: the state is removed whether it matches, is expired, or not. */
  private async consumeState(state: string): Promise<void> {
    const bad = () =>
      new GoToSmsError('That GoTo login was not started here or expired', 'bad_state');
    // Shape check first, so junk of any length never reaches timingSafeEqual.
    if (!STATE_FORMAT.test(state)) throw bad();
    const candidate = Buffer.from(state);
    const match = (await this.store.list(this.tenant, STATE_PREFIX)).find(({ key }) => {
      const saved = Buffer.from(key.slice(STATE_PREFIX.length));
      return saved.length === candidate.length && timingSafeEqual(saved, candidate);
    });
    if (!match) throw bad();
    // compareAndSet makes the claim atomic: two callbacks with one state can't both pass.
    const claimed = await this.store.compareAndSet(this.tenant, match.key, match.value, null);
    await this.store.delete(this.tenant, match.key);
    if (!claimed || this.stateExpired(match.value)) throw bad();
  }

  /** POST to the token endpoint: Basic client auth, form body, never client_secret (C2). */
  private async tokenRequest(
    params: Record<string, string>,
    creds: { clientId: string; clientSecret: string },
  ): Promise<TokenResponse> {
    let status: number;
    let text: string;
    try {
      const res = await this.fetch(`${this.authBaseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw new TemporaryError(`GoTo token request failed: ${errorName(err)}`);
    }

    if (status === 400 || status === 401 || status === 403) {
      throw new LoginExpiredError(`GoTo refused the login (HTTP ${status}); reconnect to GoTo`);
    }
    if (status === 408 || status === 429 || status >= 500) {
      throw new TemporaryError(`GoTo token endpoint answered HTTP ${status}`);
    }
    if (status < 200 || status >= 300) {
      // Only the status and the OAuth `error` code: a proxy or IdP could echo the request
      // (refresh_token, code) back in the body.
      throw new GoToApiError(status, `GoTo token endpoint returned ${status}${oauthError(text)}`, {
        tokenEndpoint: true,
      });
    }

    // Never put a success body in an error: it holds tokens.
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new GoToApiError(status, 'Malformed token response', { tokenEndpoint: true });
    }
    if (typeof body !== 'object' || body === null) {
      throw new GoToApiError(status, 'Malformed token response', { tokenEndpoint: true });
    }
    const t = body as Partial<Record<keyof TokenResponse, unknown>>;
    if (
      typeof t.access_token !== 'string' ||
      t.access_token === '' ||
      (t.expires_in !== undefined && typeof t.expires_in !== 'number') ||
      (t.refresh_token !== undefined && typeof t.refresh_token !== 'string')
    ) {
      throw new GoToApiError(status, 'Malformed token response', { tokenEndpoint: true });
    }
    return t as TokenResponse;
  }
}
