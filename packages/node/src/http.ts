import { GoToApiError, LoginExpiredError, TemporaryError } from './errors.js';
import type { FetchLike } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface GoToHttp {
  /** Throws GoToApiError on a non-2xx answer; a 204 or empty body resolves to `{}`. */
  json<T>(
    method: string,
    path: string,
    body?: unknown,
    o?: { timeoutMs?: number; query?: Record<string, string> },
  ): Promise<T>;
}

/** Bearer-authenticated JSON calls to the GoTo API. On a 401: forceRefresh once, retry once. */
export function createGoToHttp(o: {
  apiBaseUrl: string;
  fetch: FetchLike;
  getToken: () => Promise<string>;
  forceRefresh: () => Promise<string>;
}): GoToHttp {
  return {
    async json<T>(
      method: string,
      path: string,
      body?: unknown,
      opts: { timeoutMs?: number; query?: Record<string, string> } = {},
    ): Promise<T> {
      const query = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
      const url = `${o.apiBaseUrl}${path}${query}`;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // Everything inside here happens after the request left, so failures are
      // "requestSent": the caller can't know whether GoTo acted on it.
      const call = async (
        token: string,
      ): Promise<{ status: number; ok: boolean; text: string }> => {
        try {
          const res = await o.fetch(url, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/json',
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            // The signal also covers reading the body below.
            signal: AbortSignal.timeout(timeoutMs),
          });
          return { status: res.status, ok: res.ok, text: await res.text() };
        } catch (err) {
          throw new TemporaryError(`GoTo ${method} ${path} failed: ${errorName(err)}`, {
            requestSent: true,
          });
        }
      };

      // Token errors (NotConfigured/LoginExpired/Temporary) propagate unchanged.
      let res = await call(await o.getToken());
      if (res.status === 401) {
        res = await call(await o.forceRefresh());
        // A freshly refreshed token was refused too: the login no longer has access.
        if (res.status === 401) throw new LoginExpiredError();
      }
      if (!res.ok) throw new GoToApiError(res.status, res.text);
      if (res.status === 204 || res.text === '') return {} as T;
      try {
        return JSON.parse(res.text) as T;
      } catch {
        throw new GoToApiError(res.status, `Malformed JSON: ${res.text}`);
      }
    },
  };
}

/** A short, secret-free description of a fetch failure ("TimeoutError", "TypeError"). */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}
