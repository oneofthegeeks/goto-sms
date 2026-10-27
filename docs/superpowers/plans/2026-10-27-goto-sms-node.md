# goto-sms (Node) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@oneofthegeeks/goto-sms` 0.1.0. It is an unofficial Node package that sends and receives GoTo Connect texts, handles STOP/START/HELP, and serves its own setup page. The plan also delivers the shared setup page, the HTTP contract and the conformance checklist that later language ports reuse.

**Architecture:**
- A framework-free TypeScript core, made of small modules wired together by `createGoToSms()`:
  - config resolution, OAuth, accounts/numbers discovery, send;
  - inbound (webhook + polling), opt-outs and the message log;
  - all of it over a minimal async key-value store interface (file, memory and SQLite adapters).
- The HTTP layer is a pure `handle(request) → response` function. A thin Express router wraps it.
- The setup page is a separate workspace. It builds to one self-contained HTML file, which is copied into the Node package.

**Tech Stack:**
- TypeScript (strict), Node ≥ 20, global `fetch`/`crypto`.
- tsup for the ESM+CJS+d.ts build.
- `node:test` run through `tsx`; oxlint `--type-aware` + prettier.
- esbuild for the setup page; Playwright for one browser smoke test.
- Express as a peer dependency; `better-sqlite3` as an optional peer dependency.

**Spec:** `docs/superpowers/specs/2026-10-27-goto-sms-design.md`. Read it before starting any task. Its "Conformance checklist" numbers (C1–C23) are cited below.

## Global Constraints

- Package name `@oneofthegeeks/goto-sms`, version `0.1.0`, MIT license. The README's first lines say: "Unofficial. Not affiliated with or endorsed by GoTo."
- `engines.node: ">=20"`. **Zero runtime dependencies.** `express` (`^4.18 || ^5`) is a peer dependency; `better-sqlite3` is an optional peer dependency.
- Base URLs: `https://authentication.logmeininc.com` (auth) and `https://api.goto.com` (API). Both can be overridden with the options `authBaseUrl` / `apiBaseUrl`, which tests use.
- **No `scope` and no `prompt`** in the authorize URL (C1).
- Logs never contain tokens, secrets or message bodies at `info` level or above. API responses never contain secrets (C22).
- Defaults:
  - state TTL 10 min;
  - token reuse until 60 s before expiry;
  - send timeout 10 000 ms;
  - poll interval 30 000 ms;
  - inbound limit 10/hour/number;
  - log retention 90 days, at most 5 000 entries;
  - max body 1 600 characters.
- STOP words: `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT`. START words: `START, UNSTOP, YES` (`YES` can be turned off with `yesIsOptIn: false`). HELP words: `HELP, INFO`.
- Env vars: `GOTO_CLIENT_ID`, `GOTO_CLIENT_SECRET`, `GOTO_ACCOUNT_KEY`, `GOTO_FROM_NUMBER`, `GOTO_REFRESH_TOKEN`, `GOTO_SMS_ENCRYPTION_KEY`, `GOTO_SMS_PUBLIC_URL`.
- Precedence: options > env > store. `GOTO_REFRESH_TOKEN` only seeds the store.
- Every module takes `fetch`, `now: () => number` and `logger` by injection. No test touches the real GoTo.
- The root `package.json` scripts `typecheck`, `lint` and `test` must pass at every commit (Taylor's commit gate runs them).
- Conventional Commits. Every commit message ends with the attribution lines from the session.

## Review Focus

1. **Loosely formatted phone input** must normalize, not fail: `(801) 555-0100`, `801.555.0100`, `1 801 555 0100`, `+1 801-555-0100`, and numbers with surrounding whitespace. Junk such as `555-0100`, `call me` or `+1` must be `invalid_number` with no network call. Test: Task 2.
2. **Keyword texts with punctuation or padding**, such as `Stop.`, ` stop `, `STOP!` and `Unsubscribe please`. The first three must act as STOP (trim, uppercase, strip trailing punctuation). The last must **not**, because only a whole-message match counts. Test: Task 9.
3. **A restart between Connect and the OAuth callback** must still finish the login, because state lives in the store and not in memory. Test: Task 6.
4. **A changed or missing encryption key on an existing data file** must give status `credentialsUnreadable: true` and the message "Saved GoTo credentials can't be decrypted — re-enter the client secret and reconnect". It must not crash and must not send garbage. Test: Task 4.
5. **Setup page mounted at a nested path behind a proxy** (`app.use('/admin/tools/sms', …)` with `publicUrl` on another host): the redirect URI is `publicUrl + mountPath + '/callback'`, and every page URL is relative. Tests: Task 12 (redirect) and Task 13 (relative URLs).

---

## File Structure

```
package.json                    # private root, npm workspaces: setup-ui, packages/node, examples/express-app
tsconfig.base.json  .oxlintrc.json  .prettierrc  .gitignore  LICENSE  README.md  CLAUDE.md  CHANGELOG.md
contract/http.md                # language-neutral endpoint spec (Task 12)
contract/conformance.md         # C1–C23 → test names (Task 15)
setup-ui/                       # shared page: src/index.html, src/app.ts, src/styles.css, build.mjs → dist/index.html
packages/node/
  package.json  tsconfig.json  tsup.config.ts  README.md
  src/
    index.ts        # public exports
    types.ts        # shared types (Task 1)
    errors.ts       # error classes (Task 1)
    phone.ts        # normalizePhone (Task 2)
    store/types.ts  store/memory.ts  store/file.ts  store/sqlite.ts  store/conformance.ts (Task 3)
    secrets.ts      # SecretBox + key resolution (Task 4)
    config.ts       # ConfigResolver (Task 5)
    oauth.ts        # GoToAuth (Task 6)
    http.ts         # gotoFetch helper: bearer, timeout, JSON, error capture (Task 6)
    directory.ts    # listAccounts, listNumbers (Task 7)
    optouts.ts  log.ts               # (Task 8)
    send.ts         # Sender (Task 8)
    inbound/processor.ts  inbound/keywords.ts  inbound/webhook.ts  inbound/poller.ts  (Tasks 9–11)
    client.ts       # createGoToSms facade + process lock (Task 11)
    server/handlers.ts  server/express.ts  (Tasks 12–13)
  test/
    helpers/fake-goto.ts  helpers/fixtures.ts   # (Task 6, grown by later tasks)
    *.test.ts
examples/express-app/  server.mjs  Dockerfile  README.md   (Task 14)
e2e/setup.spec.ts                 (Task 14)
.github/workflows/ci.yml  .github/workflows/publish.yml   (Tasks 1, 15)
```

---

### Task 1: Repo scaffold, shared types, errors, CI

**Files:**
- Create the root files listed above.
- Create `packages/node/{package.json,tsconfig.json,tsup.config.ts}`, `src/{index.ts,types.ts,errors.ts}` and `test/smoke.test.ts`.
- Create `.github/workflows/ci.yml`.

**Interfaces — Produces** (`src/types.ts`; export all of these from `index.ts`):
```ts
export type SendStatus = 'sent'|'opted_out'|'invalid_number'|'uncertain'|'not_connected'|'rejected';
export interface SendResult { status: SendStatus; reason?: string; retryable?: boolean; messageId?: string; to?: string; deduped?: boolean }
export interface SendOptions { dedupeKey?: string }
export type Keyword = 'STOP'|'START'|'HELP';
export interface InboundMessage { id: string; from: string; to: string; text: string; receivedAt: string; accountKey?: string; keyword?: Keyword; raw: unknown }
export interface LogEntry { id: string; direction: 'outbound'|'inbound'; from: string; to: string; status: string; reason?: string; gotoId?: string; at: string }
export interface Logger { debug(m: string, x?: object): void; info(m: string, x?: object): void; warn(m: string, x?: object): void; error(m: string, x?: object): void }
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export const VERSION: string; // injected by tsup `define` from package.json; 'dev' under tsx
```
`src/errors.ts`:
- `GoToSmsError` (base; has `code: string`).
- `LoginExpiredError` (`code 'login_expired'`).
- `TemporaryError` (`'temporary'`).
- `NotConfiguredError` (`'not_configured'`).
- `GoToApiError` (`'api'`, with `status: number`, `body: string` cut to 500 characters).
- `SendFailedError` (`'send_failed'`, with `result: SendResult`).

- [ ] **Step 1:** Write the root `package.json`:
  - `private: true`;
  - workspaces `["setup-ui","packages/node","examples/express-app"]`;
  - scripts: `build` (setup-ui then node), `typecheck` (`tsc -p packages/node --noEmit && tsc -p setup-ui --noEmit`), `lint` (`oxlint --type-aware && prettier --check .`), `test` (`npm -w packages/node test`).

  Write `tsconfig.base.json` with `strict` and `noUncheckedIndexedAccess`, `module`/`moduleResolution` `NodeNext`, target ES2022.
- [ ] **Step 2:** Write `packages/node/package.json`:
  - `"type":"module"`;
  - `exports` with `import`→`dist/index.js`, `require`→`dist/index.cjs` and `types`;
  - `files: ["dist"]`;
  - scripts: `build: tsup`, `test: tsx --test test/*.test.ts`.

  `tsup.config.ts` builds ESM+CJS+dts and defines `__VERSION__`.
- [ ] **Step 3:** Write the failing test `test/smoke.test.ts`: `import { VERSION, GoToSmsError } from '../src/index.ts'`, then `assert.equal(typeof VERSION,'string')` and `assert.ok(new GoToSmsError('x','c') instanceof Error)`. Run `npm test`: it fails on the missing module.
- [ ] **Step 4:** Implement `types.ts`, `errors.ts` and `index.ts`. Run `npm test && npm run typecheck && npm run lint`: all pass.
- [ ] **Step 5:** Write `ci.yml`:
  - triggers: push to `main` and `pull_request`;
  - matrix: Node 20, 22, 24;
  - steps: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`.
- [ ] **Step 6:** Write the docs files:
  - `README.md`: a stub with the unofficial disclaimer line and the install command.
  - `CLAUDE.md`: all seven template sections. Under Deployment: "library: tag → publish.yml → npm (manual approval)". Under Testing: describe only the smoke test for now.
  - `CHANGELOG.md`: an "Unreleased" section.
  - `LICENSE`: MIT, © 2026 Taylor Brinton.
  - `.gitignore`: `node_modules/`, `dist/`, `data/`, `.env`, `*.db`, `*.sqlite`, `test-results/`.
- [ ] **Step 7:** Commit `chore: scaffold goto-sms monorepo`.

### Task 2: Phone normalization (C8)

**Files:** Create `src/phone.ts` and `test/phone.test.ts`.

**Interfaces — Produces:** `normalizePhone(raw: string): string | null`. It returns E.164, or `null` for invalid input.

- [ ] **Step 1:** Write the failing tests:
  ```ts
  test('NANP loose formats', () => { for (const s of ['(801) 555-0123','801.555.0123','1 801 555 0123','+1 801-555-0123',' 8015550123 ']) assert.equal(normalizePhone(s), '+18015550123'); });
  test('NANP rules: area/exchange start 2-9, no N11 area', () => { for (const s of ['1015550123','8011550123','9115550123']) assert.equal(normalizePhone(s), null); });
  test('junk is null', () => { for (const s of ['555-0123','call me','+1','','+12']) assert.equal(normalizePhone(s), null); });
  test('international + passes through 8–15 digits', () => { assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958'); assert.equal(normalizePhone('+1234567'), null); });
  ```
- [ ] **Step 2:** Run `npm test`: FAIL.
- [ ] **Step 3:** Implement. NANP validation as in `~/dev/geekonomics-app/server/lib/phone.js`. Leading `+` handling as in `~/dev/swu-ideas/src/server/sms.ts:normalizePhone`, but a `+1` number must also pass the NANP rules.
- [ ] **Step 4:** Run `npm test`: PASS.
- [ ] **Step 5:** Commit `feat(node): E.164 phone normalization`.

### Task 3: Store interface + memory, file and SQLite adapters

**Files:**
- Create `src/store/{types,memory,file,sqlite,conformance}.ts`.
- Test: `test/store.test.ts`.

**Interfaces — Produces** (`src/store/types.ts`):
```ts
export type Json = null|boolean|number|string|Json[]|{[k: string]: Json};
export interface GoToSmsStore {
  get(tenant: string, key: string): Promise<Json|undefined>;
  set(tenant: string, key: string, value: Json): Promise<void>;
  delete(tenant: string, key: string): Promise<void>;
  list(tenant: string, prefix: string): Promise<Array<{ key: string; value: Json }>>; // sorted by key ascending
  compareAndSet(tenant: string, key: string, expected: Json|undefined, next: Json): Promise<boolean>; // deep-equal compare
  claim(tenant: string, key: string, ttlMs: number, owner: string): Promise<boolean>; // true if free, expired, or already owned by `owner`
}
export class MemoryStore implements GoToSmsStore { constructor(now?: () => number) }
export class FileStore implements GoToSmsStore { constructor(opts: { path: string; now?: () => number }) } // path e.g. `${dataDir}/goto-sms.json`
export class SqliteStore implements GoToSmsStore { constructor(db: import('better-sqlite3').Database, opts?: { table?: string; now?: () => number }) } // default table goto_sms_kv
export function runStoreConformance(name: string, make: () => Promise<GoToSmsStore>): void; // registers node:test cases
```

- [ ] **Step 1:** Write `conformance.ts` with these cases:
  - set/get round trip; `get` of a missing key is `undefined`;
  - `delete`;
  - `list('log:')` returns only that prefix, sorted;
  - tenants are isolated;
  - `compareAndSet` succeeds when the value matches (including `undefined` for absent) and fails otherwise;
  - `claim`: a first claimer gets true, a second owner gets false until the TTL passes (advance an injected `now`), and the same owner can re-claim.

  `test/store.test.ts` calls it for `MemoryStore`, for `FileStore` (in a tmp dir), and for `SqliteStore`. The SQLite run is skipped when `better-sqlite3` can't be imported; add `better-sqlite3` as a devDependency so CI runs it.
- [ ] **Step 2:** Add FileStore-only tests:
  - a new `FileStore` on the same path sees earlier writes;
  - writes are atomic: the store writes `path.tmp` and then renames it, so after a write no `.tmp` file remains;
  - the file is created with mode `0o600`;
  - a corrupt JSON file is renamed to `*.corrupt-<ts>`, the store starts empty and a warning is logged.
- [ ] **Step 3:** Run: FAIL.
- [ ] **Step 4:** Implement:
  - FileStore keeps an in-memory map and serializes writes through one promise chain, writing tmp+rename on every mutation.
  - SqliteStore uses WAL, the sync API and one table `(tenant, key, value TEXT, PRIMARY KEY(tenant,key))`. `claim` stores `{owner, expiresAt}` as the value.
- [ ] **Step 5:** Run: PASS.
- [ ] **Step 6:** Commit `feat(node): key-value store with file, memory and sqlite adapters`.

### Task 4: Secrets at rest (C22)

**Files:** Create `src/secrets.ts` and `test/secrets.test.ts`.

**Interfaces — Produces:**
```ts
export class SecretBox { constructor(key: Buffer); seal(plain: string): string /* "v1.<iv b64>.<tag b64>.<ct b64>" */; open(sealed: string): string /* throws DecryptError */ }
export class DecryptError extends GoToSmsError {}
export async function resolveEncryptionKey(o: { optionKey?: string; env: NodeJS.ProcessEnv; dataDir?: string; logger: Logger }): Promise<{ key: Buffer; source: 'option'|'env'|'keyfile' }>
```
How the key is resolved:
- A string key from the option or `GOTO_SMS_ENCRYPTION_KEY` becomes `sha256(utf8)`.
- Otherwise, `${dataDir}/.goto-sms.key` holds 32 random bytes, created with mode `0o600`, and a warning is logged: "set GOTO_SMS_ENCRYPTION_KEY in production".
- No key and no dataDir: throw `NotConfiguredError("Set GOTO_SMS_ENCRYPTION_KEY (required when no dataDir is used)")`.

- [ ] **Step 1:** Write the failing tests:
  - a seal/open round trip;
  - two seals of the same text differ (random IV);
  - a tampered ciphertext makes `open` throw `DecryptError`;
  - a different key makes `open` throw `DecryptError` (Review Focus 4; the status surfacing is tested in Task 5);
  - a keyfile is created once and reused, with mode 0600;
  - the env key wins over the keyfile.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement with `crypto.createCipheriv('aes-256-gcm')`.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(node): AES-GCM secret box and key resolution`.

### Task 5: Config resolution — options > env > store

**Files:** Create `src/config.ts` and `test/config.test.ts`.

**Interfaces:**
- Consumes `GoToSmsStore` and `SecretBox`.
- Produces:
```ts
export type ConfigField = 'clientId'|'clientSecret'|'accountKey'|'fromNumber';
export type Source = 'options'|'env'|'store'|'unset';
export interface ResolvedConfig { clientId?: string; clientSecret?: string; accountKey?: string; fromNumber?: string; sources: Record<ConfigField, Source>; credentialsUnreadable: boolean }
export class ConfigResolver {
  constructor(o: { store: GoToSmsStore; tenant: string; box: SecretBox; options: Partial<Record<ConfigField, string>>; env: NodeJS.ProcessEnv });
  resolve(): Promise<ResolvedConfig>;
  save(patch: Partial<Record<ConfigField, string>>): Promise<void>; // throws GoToSmsError('locked', …) for any field whose source is options/env; '' for clientSecret = keep
  seedRefreshToken(): string | undefined; // options.refreshToken ?? env.GOTO_REFRESH_TOKEN
}
```
Store keys:
- `config:clientId`, `config:accountKey`, `config:fromNumber` (plain).
- `config:clientSecret` (sealed).
- `fromNumber` is saved normalized; an invalid value throws `GoToSmsError('invalid_number')`.

- [ ] **Step 1:** Write the failing tests:
  - the option beats env, which beats the store; `sources` is correct for each case;
  - `save` of an env-set field throws code `locked`;
  - a blank `clientSecret` save keeps the stored value;
  - the secret is stored sealed: the raw store value doesn't contain the plaintext;
  - **a store sealed with key A and resolved with key B** gives `credentialsUnreadable: true`, `clientSecret: undefined`, and does not throw (Review Focus 4).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(node): config precedence options > env > store`.

### Task 6: Fake GoTo, HTTP helper and OAuth (C1–C5)

**Files:**
- Create `test/helpers/fake-goto.ts`, `src/http.ts` and `src/oauth.ts`.
- Test: `test/oauth.test.ts`.

**Interfaces:**
- Consumes `ConfigResolver`, `GoToSmsStore`, `SecretBox` and the errors.
- Produces:
```ts
// test/helpers/fake-goto.ts — a node:http server on 127.0.0.1:0 serving BOTH auth and API paths.
export interface FakeGoTo {
  url: string;                                   // use as authBaseUrl AND apiBaseUrl
  requests: Array<{ method: string; path: string; headers: Record<string,string>; body: string }>;
  sent: Array<{ ownerPhoneNumber: string; contactPhoneNumbers: string[]; body: string }>;
  tokens: { valid: Set<string>; refresh: string; rotateOnRefresh: boolean; codes: Map<string,string> };
  failNext(method: string, pathPrefix: string, status: number, body?: unknown): void;
  hangNext(method: string, pathPrefix: string): void;   // accepts request, never responds (timeout tests)
  inbound: Array<{ id: string; from: string; to: string; body: string; timestamp: string }>; // for polling
  close(): Promise<void>;
}
export async function startFakeGoTo(opts?: { clientId?: string; clientSecret?: string }): Promise<FakeGoTo>;
// default credentials: clientId 'cid', clientSecret 'csecret'; issues authorization code 'code-ok'

// src/http.ts
export interface GoToHttp { json<T>(method: string, path: string, body?: unknown, o?: { timeoutMs?: number; query?: Record<string,string> }): Promise<T> } // throws GoToApiError on !ok
export function createGoToHttp(o: { apiBaseUrl: string; fetch: FetchLike; getToken: () => Promise<string>; forceRefresh: () => Promise<string> }): GoToHttp; // on 401: forceRefresh once, retry once

// src/oauth.ts
export class GoToAuth {
  constructor(o: { store: GoToSmsStore; tenant: string; box: SecretBox; config: ConfigResolver; fetch: FetchLike; authBaseUrl: string; redirectUri: string; now: () => number; logger: Logger });
  startConnect(): Promise<string>;                       // authorize URL; saves `state:<s>` = { expiresAt }
  finishConnect(code: string, state: string): Promise<void>; // throws GoToSmsError('bad_state') | LoginExpiredError
  getAccessToken(): Promise<string>;                     // throws NotConfiguredError | LoginExpiredError | TemporaryError
  forceRefresh(): Promise<string>;
  disconnect(): Promise<void>;
  status(): Promise<{ connected: boolean; loginExpired: boolean; refreshSource?: 'login'|'seeded-from-env' }>;
}
```
How the fake must answer is taken from the reference code:
- token: `~/dev/swu-ideas/src/server/sms.ts` `tokenRequest`;
- Users/me, channels and subscriptions: `~/dev/party-invites/server/sms.js:160-206`;
- phone-numbers paging: `~/dev/swu-ideas/src/server/sms.ts:listNumbers`;
- conversations and messages: `~/dev/geeks-tracker/server/sms.js:100-165`.

The fake's `/oauth/token` behavior:
- It **requires a Basic auth header and rejects** a body that contains `client_secret` with 400.
- `grant_type=authorization_code` with `code-ok` succeeds.
- `grant_type=refresh_token` checks `tokens.refresh` and returns `refresh_token` only when `rotateOnRefresh` is true.

Store key `tokens`: `{ access: sealed, refresh: sealed, expiresAt: number, source: 'login'|'seeded-from-env' }`. Store key `login_expired`: `true` while the login is dead.

- [ ] **Step 1:** Write the failing tests, with an injected `now`:
  - `C1 authorize URL has client_id, redirect_uri, response_type=code, state and no scope/prompt`.
  - `C2 token call uses Basic auth and form body without client_secret`.
  - `C3 state is single-use and expires after 10 min`: a reused state and an expired state both reject with `bad_state`; a wrong-length state rejects without throwing a TypeError.
  - `C3 two pending states both work`.
  - **`state survives a restart`**: call `startConnect` on auth A, build a new `GoToAuth` B over the same FileStore, and `B.finishConnect` succeeds (Review Focus 3).
  - `token reused until 60 s before expiry`: count `/oauth/token` requests.
  - `C4 single-flight`: 5 concurrent `getAccessToken()` calls on an expired token produce one refresh request.
  - `C4 rotation`: with `rotateOnRefresh` true the stored refresh token changes; with it false the stored one is kept.
  - `C5 refresh 400/401/403 → LoginExpiredError and login_expired flag; later calls fail fast without network`.
  - `C5 refresh 503 and hang → TemporaryError and no flag`.
  - `seeded from env`: with an empty store and `GOTO_REFRESH_TOKEN` set, the first `getAccessToken` refreshes with the seed, stores the result, and `status().refreshSource === 'seeded-from-env'`. After a rotation, a restart with the same env still uses the stored token, not the seed.
  - `http 401 → one forceRefresh and one retry; second 401 → LoginExpiredError`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement `fake-goto.ts`, `http.ts` and `oauth.ts`:
  - Single-flight is an in-memory `Promise` field. The rotated token is written with `compareAndSet` against the previous `tokens` value.
  - State is compared via the store key lookup, using `timingSafeEqual` on equal-length buffers.
  - Use a 10 s timeout on token calls.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(node): GoTo OAuth with single-flight refresh and rotation`.

### Task 7: Accounts and numbers (C6, C7)

**Files:**
- Create `src/directory.ts`; extend `fake-goto.ts`.
- Test: `test/directory.test.ts`.

**Interfaces — Produces:**
```ts
export interface GoToAccount { key: string; name: string }
export interface GoToNumber { number: string; name: string; accountKey: string; smsEnabled?: boolean }
export async function listAccounts(http: GoToHttp): Promise<GoToAccount[]>;
export async function listNumbers(http: GoToHttp, accountKey: string): Promise<GoToNumber[]>;
```

- [ ] **Step 1:** Write the failing tests:
  - `C6 accounts from urn:scim:schemas:extension:getgo:1.0.accounts[] (value→key, display→name)`. A missing extension gives `[]`.
  - `C7 numbers follow pageMarker across 3 pages and dedupe by number`. The fake serves pages of 2 with one duplicate.
  - Numbers are normalized to E.164, and `smsEnabled` is passed through when present.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement. `pageSize=100`; stop when `nextPageMarker` is absent; hard cap of 50 pages.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(node): list GoTo accounts and phone numbers`.

### Task 8: Opt-outs, message log and Sender (C9–C15)

**Files:**
- Create `src/optouts.ts`, `src/log.ts` and `src/send.ts`.
- Test: `test/send.test.ts`.

**Interfaces — Produces:**
```ts
export class OptOuts { constructor(store: GoToSmsStore, tenant: string, now: () => number);
  has(e164: string): Promise<boolean>; add(e164: string, source: 'keyword'|'admin'): Promise<void>; remove(e164: string): Promise<void>;
  list(): Promise<Array<{ number: string; at: string; source: string }>> } // keys `optout:<e164>`
export class MessageLog { constructor(store: GoToSmsStore, tenant: string, now: () => number, o?: { retentionDays?: number; maxEntries?: number });
  append(e: Omit<LogEntry,'id'|'at'>): Promise<LogEntry>; list(limit?: number): Promise<LogEntry[]> /* newest first */; prune(): Promise<void> } // keys `log:<zero-padded ms>:<rand>`
export class Sender {
  constructor(o: { http: GoToHttp; auth: GoToAuth; config: ConfigResolver; optOuts: OptOuts; log: MessageLog; store: GoToSmsStore; tenant: string; timeoutMs: number; maxBody: number; logOnly: boolean; env: NodeJS.ProcessEnv; logger: Logger });
  send(to: string, text: string, o?: SendOptions & { bypassOptOut?: boolean }): Promise<SendResult>; // never throws for expected outcomes
  sendOrThrow(to: string, text: string, o?: SendOptions): Promise<SendResult>;                        // throws SendFailedError unless status 'sent'
}
```

The order of checks inside `send`:
1. `logOnly` is set and `NODE_ENV==='production'`: throw `GoToSmsError('log_only_in_production')` at **construction** time instead.
2. Normalize `to`. An invalid number returns `invalid_number`.
3. No `fromNumber`, client config or connection returns `not_connected`, with a reason naming what's missing.
4. `to === fromNumber` returns `rejected` with "GoTo can't text the sending number itself".
5. The number is opted out (unless `bypassOptOut`) and returns `opted_out`.
6. The text is empty or longer than 1 600 characters and returns `rejected`.
7. `dedupeKey`: `claim('dedupe:<key>')`. If a result is already stored under `dedupe:<key>:result` with status `sent` or `uncertain`, return it with `deduped: true`. Concurrent calls with the same key in one process share one in-flight promise.
8. `logOnly`: log the send and return `{status:'sent', reason:'log-only mode'}`.
9. POST `/messaging/v1/messages` with `{ownerPhoneNumber, contactPhoneNumbers:[to], body}`.
10. Map the outcome:
    - 2xx: `sent`, with `messageId` from `id`.
    - A timeout, or a network error after the request was sent: `uncertain`, with no retry.
    - 401 (after the http retry) / `LoginExpiredError`: `not_connected`, reason "GoTo login expired — reconnect".
    - 403: `rejected`, reason "GoTo refused (403): the login lacks messaging.v1.send, or this number isn't SMS-enabled in GoTo Admin".
    - A response body matching `/10dlc|campaign/i`: `rejected`, reason "This number isn't registered to a 10DLC texting campaign".
    - 429/5xx: `rejected` with `retryable: true`.
    - Any other 4xx: `rejected` with GoTo's message.
11. Always append to the log, without the body. Store the dedupe result.

- [ ] **Step 1:** Write the failing tests, one per numbered rule above, named after the matching C-number:
  - `C9 owner number refused (no network)`;
  - `C10 opted-out refused (no network)`;
  - `C11 same dedupeKey sends once, sequentially and concurrently`;
  - `C12 hangNext → uncertain, fake saw exactly 1 POST`;
  - `C13 401 then success → sent after one refresh`;
  - `C14 403 and 10DLC reasons`;
  - `C15 unconfigured → not_connected, fake saw 0 POSTs; logOnly + NODE_ENV=production throws at construction`;
  - `sendOrThrow throws SendFailedError carrying result`;
  - `1601 chars rejected, 1600 sent`;
  - `log has entry with status/reason and no body`;
  - `MessageLog.prune removes >90-day and >maxEntries entries`;
  - `OptOuts add/has/remove/list`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(node): sender with opt-out, dedupe and error translation`.

### Task 9: Inbound processor and keywords (C20, C21, durable STOP)

**Files:**
- Create `src/inbound/keywords.ts` and `src/inbound/processor.ts`.
- Test: `test/inbound.test.ts`.

**Interfaces — Produces:**
```ts
export function detectKeyword(text: string, o: { yesIsOptIn: boolean }): Keyword | undefined; // trim, uppercase, strip trailing [.!?,]+, whole-message match
export interface KeywordReplies { stop: string; start: string; help: string } // defaults below
export class InboundProcessor {
  constructor(o: { store: GoToSmsStore; tenant: string; sender: Sender; optOuts: OptOuts; log: MessageLog; emit: (m: InboundMessage) => void; replies: KeywordReplies; yesIsOptIn: boolean; perHour: number; now: () => number; logger: Logger });
  persist(m: Omit<InboundMessage,'keyword'>): Promise<boolean>; // writes `inbound:pending:<id>` unless `inbound:seen:<id>`; returns false for duplicates
  process(id: string): Promise<void>;   // keyword → opt-out change + reply (bypassOptOut for STOP confirm) BEFORE rate limit; then rate limit; log; emit (try/catch); mark seen; delete pending
  replayPending(): Promise<number>;     // processes every `inbound:pending:*`, returns count
}
```
Default replies:
- stop: "You're unsubscribed and won't get more texts from this number. Reply START to resubscribe."
- start: "You're resubscribed. Reply STOP to unsubscribe."
- help: "Reply STOP to unsubscribe. Msg & data rates may apply."

Rate-limit key: `rate:<from>:<floor(now/3600000)>`. Seen ids are kept for the log retention window (90 days) and pruned along with the log.

- [ ] **Step 1:** Write the failing tests:
  - `detectKeyword` maps `'Stop.'`, `' stop '` and `'STOP!'` to STOP; `'Unsubscribe please'` gives undefined; `'yes'` gives START only when `yesIsOptIn` (Review Focus 2).
  - `C20 STOP adds opt-out, sends exactly one confirmation even though now opted out, emits with keyword`.
  - `C20 START removes`; `C20 HELP replies with configured text`.
  - `C21 11th text in an hour is logged and not emitted`.
  - **`STOP as 12th text in the hour still opts out`**.
  - **`pending inbound replayed after restart`**: `persist` without `process`, then a new processor over the same store, and `replayPending()` emits once.
  - `duplicate GoTo id emitted once`.
  - `handler that throws doesn't stop processing`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(node): inbound processing with durable STOP/START/HELP`.

### Task 10: Webhook setup and parsing (C16–C18)

**Files:**
- Create `src/inbound/webhook.ts`; extend `fake-goto.ts`.
- Test: `test/webhook.test.ts`.

**Interfaces — Produces:**
```ts
export function parseWebhookEnvelope(body: unknown): Omit<InboundMessage,'keyword'> | null; // tolerant; port ~/dev/party-invites/server/features/inbound.js parseEnvelope; id from payload.id ?? sha256(from|to|text|timestamp)
export async function enableWebhook(o: { http: GoToHttp; store: GoToSmsStore; tenant: string; accountKey: string; webhookUrl: string; channelPrefix: string }): Promise<{ channelId: string; subscriptionId: string }>;
export async function disableWebhook(o: { http: GoToHttp; store: GoToSmsStore; tenant: string }): Promise<void>; // DELETE subscription (ignore 404), clear stored ids
export function checkWebhookSecret(given: string, expected: string): boolean; // constant time, false on length mismatch
```
The webhook secret is stored at `inbound:webhookSecret`: 32 random bytes, base64url. It is rotated on disable.

- [ ] **Step 1:** Write the failing tests:
  - `C17 creates channel with channelType Webhook when none matches; reuses a matching one` (count POSTs to `/notification-channel/v1/channels/`).
  - `C18 subscription POST has accountKey in query and body; on 4xx retries with ORGANIZATION; existing matching subscription → no POST`.
  - `C16 parse: party-invites envelope → message; non-INBOUND_MESSAGE type → null; garbage → null`.
  - `checkWebhookSecret` with good, bad and different-length values.
  - The 403 error body is carried on `GoToApiError`, so the UI can show it verbatim.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement by porting `subscribeInbound` from `~/dev/party-invites/server/sms.js:180-206`.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(node): webhook channel/subscription setup and envelope parsing`.

### Task 11: Poller and `createGoToSms` facade (C19)

**Files:**
- Create `src/inbound/poller.ts` and `src/client.ts`; export from `index.ts`.
- Test: `test/poller.test.ts` and `test/client.test.ts`.

**Interfaces — Produces:**
```ts
export class Poller { constructor(o: { http: GoToHttp; config: ConfigResolver; processor: InboundProcessor; store: GoToSmsStore; tenant: string; intervalMs: number; now: () => number; logger: Logger });
  tick(): Promise<number>; start(): void; stop(): void } // cursor key `poll:cursor` (ISO); compares with Date.parse; persists via processor.persist then process

export interface GoToSmsOptions {
  publicUrl?: string; mountPath?: string /* default '/goto-sms' */; dataDir?: string; store?: GoToSmsStore; tenant?: string;
  authorize?: (req: import('node:http').IncomingMessage) => boolean | Promise<boolean>; allowUnauthenticatedSetup?: boolean;
  clientId?: string; clientSecret?: string; accountKey?: string; fromNumber?: string; refreshToken?: string; encryptionKey?: string;
  logOnly?: boolean; replies?: Partial<KeywordReplies>; yesIsOptIn?: boolean; pollIntervalMs?: number; sendTimeoutMs?: number; inboundPerHour?: number;
  logRetentionDays?: number; logger?: Logger | false; fetch?: FetchLike; authBaseUrl?: string; apiBaseUrl?: string; env?: NodeJS.ProcessEnv; now?: () => number;
}
export interface GoToSms {
  send(to: string, text: string, o?: SendOptions): Promise<SendResult>;
  sendOrThrow(to: string, text: string, o?: SendOptions): Promise<SendResult>;
  on(ev: 'message', fn: (m: InboundMessage) => void): this; off(ev: 'message', fn: (m: InboundMessage) => void): this;
  optOuts: Pick<OptOuts, 'has'|'add'|'remove'|'list'>;
  status(): Promise<StatusPayload>;   // StatusPayload defined in Task 12
  router(): import('express').Router; // Task 13
  webhookRouter(): import('express').Router; // Task 13 — only POST /inbound/:secret
  ready: Promise<void>;               // resolves after key resolution, process lock, replayPending, poller start
  close(): Promise<void>;
  /** @internal for handlers */ readonly core: Core;
}
export function createGoToSms(o?: GoToSmsOptions): GoToSms;
```
`Core` is an internal object holding all the module instances (auth, http, sender, config, processor, poller, optOuts, log, store, tenant, options with defaults). Handlers in Task 12 use it.

Facade rules:
- `publicUrl = o.publicUrl ?? env.GOTO_SMS_PUBLIC_URL`. `redirectUri = publicUrl + mountPath + '/callback'`, and `webhookUrl = publicUrl + mountPath + '/inbound/' + secret`.
- Default store is `new FileStore({ path: dataDir + '/goto-sms.json' })`; `dataDir` defaults to `./data`.
- Process lock: `claim('process-lock', 90_000, randomUUID())`, refreshed every 30 s. If the claim fails, `logger.warn("Another process is using this goto-sms store; run one process per store (see README)")` and continue.
- Incoming mode is stored at `inbound:mode` (`'webhook'|'polling'|'off'`, default `'off'`). The poller runs only in `'polling'`.
- `logger: false` silences logging. The default logger is `console`, prefixed `[goto-sms]`.
- `close()` stops the poller and the lock timer and releases the lock.

- [ ] **Step 1:** Write the failing tests:
  - `C19 polling dedupes across ticks`.
  - `C19 mixed µs/ms timestamps ordered by Date.parse`, with fixtures `'2026-10-27T10:00:00.123456Z'` and `'2026-10-27T10:00:00.2Z'`.
  - `cursor survives restart`.
  - `facade end-to-end on fake`: preload the store with tokens and config through `ConfigResolver.save` and `GoToAuth.finishConnect`; then `send` gives `sent`; `fake.inbound.push(...)`, then `poller.tick()`, then the `on('message')` handler is called.
  - `second instance on same store logs the one-process warning`.
  - `ready rejects with NotConfiguredError when no dataDir/store and no encryption key`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(node): polling and createGoToSms facade`.

### Task 12: HTTP handlers and contract (C22, C23)

**Files:**
- Create `src/server/handlers.ts` and `contract/http.md`.
- Test: `test/handlers.test.ts`.

**Interfaces — Produces:**
```ts
export interface HttpRequest { method: string; path: string /* relative to mount, e.g. '/api/status' */; query: Record<string,string>; headers: Record<string,string|undefined>; body: unknown; raw: import('node:http').IncomingMessage }
export type HttpResponse = { status: number; json?: unknown; html?: string; redirect?: string };
export interface StatusPayload {
  version: string; configured: boolean; connected: boolean; loginExpired: boolean; credentialsUnreadable: boolean; ready: boolean;
  clientId?: string; accountKey?: string; fromNumber?: string; sources: Record<ConfigField, Source>; refreshSource?: 'login'|'seeded-from-env';
  redirectUri: string; incoming: { mode: 'webhook'|'polling'|'off'; webhookUrl?: string; canWebhook: boolean /* publicUrl is https */ };
  requiredScopes: string[]; // ['messaging.v1.send','messaging.v1.read','messaging.v1.notifications.manage','voice-admin.v1.read']
}
export function createHandlers(core: Core, setupHtml: string): (req: HttpRequest) => Promise<HttpResponse>;
```
Routing rules (copy this table into `contract/http.md`, with request and response bodies):
- `POST /inbound/:secret`:
  - Exempt from `authorize`.
  - A bad secret, or incoming mode not `webhook`: 404.
  - Otherwise parse, then `await processor.persist`, then **return 204**, then `processor.process(id)` without awaiting it (with `.catch(logger.error)`).
- `GET /callback`:
  - Exempt from `authorize`; authenticated by `state`.
  - Calls `finishConnect`, then redirects to `./?connected=1`, or to `./?error=<code>`.
  - On a GoTo `error` query parameter, redirects to `./?error=goto_login`. The page then explains the redirect URI and scope causes.
- All other routes call `authorize(raw)`; a false result gives 403. If no `authorize` was given and `allowUnauthenticatedSetup` is not true, **`router()` throws at creation**:
  - "goto-sms: pass authorize(req) to createGoToSms (or allowUnauthenticatedSetup: true in development)".
  - `allowUnauthenticatedSetup` with `NODE_ENV==='production'` also throws.
- Every non-GET route needs `Origin` to match the request host, or `Sec-Fetch-Site: same-origin`; otherwise 403.
- Endpoints, exactly as the spec's list:
  - `GET /` (the setup HTML)
  - `GET /api/status`
  - `POST /api/credentials`
  - `POST /api/connect` → `{url}`
  - `POST /api/disconnect`
  - `GET /api/accounts`
  - `GET /api/numbers?accountKey=`
  - `POST /api/selection`
  - `POST /api/test` `{to}` → `SendResult`
  - `POST /api/incoming` `{mode}` → enable/disable the webhook or start/stop the poller; returns status. GoTo errors come back as `{error, gotoStatus, gotoBody}`.
  - `GET /api/log?limit=` (default 50, max 500)
  - `GET /api/opt-outs`
  - `POST /api/opt-outs` `{number, action}`
- Errors are JSON `{ error: code, message }`. A `locked` field gives 409, invalid input 400, and anything else 500 with a generic message. Details are logged at debug level only.

- [ ] **Step 1:** Write the failing tests, calling the handler function directly (no Express):
  - `C23 router() without authorize throws; with authorize→false every /api route is 403; /callback and /inbound bypass authorize`.
  - `C22 /api/status never contains clientSecret or tokens`. Search `JSON.stringify(status)` for the secret value and the access token.
  - `POST without matching Origin → 403`.
  - **`redirectUri for nested mount /admin/tools/sms and publicUrl https://x.example → https://x.example/admin/tools/sms/callback`** (Review Focus 5).
  - `inbound: 204 returned and message pending in store before processing`. Make `process` slow, then assert the response arrives first.
  - `inbound bad secret → 404`.
  - `credentials POST for env-locked field → 409`.
  - `incoming webhook enable surfaces GoTo 403 body verbatim`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement. Write `contract/http.md` from the code: one section per route with method, path, auth, request, response and errors.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5:** Commit `feat(node): HTTP handlers and language-neutral contract`.

### Task 13: Setup page and Express router

**Files:**
- Create `setup-ui/{package.json,tsconfig.json,build.mjs,src/index.html,src/app.ts,src/styles.css}` and `packages/node/src/server/express.ts`.
- Modify `packages/node/package.json`: a `prebuild` step copies `../../setup-ui/dist/index.html` to `src/server/setup.html.ts` as an exported string. That file is generated and listed in `.gitignore`; tests use a stub when it's missing.
- Test: `test/express.test.ts`.

**Interfaces:**
- Consumes `createHandlers` and `StatusPayload`.
- Produces `buildExpressRouter(core: Core): Router`. It is used by `GoToSms.router()` and, filtered to `POST /inbound/:secret`, by `webhookRouter()`. It applies `express.json({ limit: '100kb' })` and maps `HttpRequest`/`HttpResponse`. `path` is taken from `req.path`. If `req.baseUrl !== mountPath`, it logs a warning once: "mounted at X but mountPath option is Y; the redirect URI shown will be wrong".

The setup page (plain TS, no framework; `build.mjs` uses esbuild to inline the JS and CSS into `dist/index.html`):
- It uses only **relative URLs** (`api/status`, not `/goto-sms/api/status`).
- Sections, in order:
  1. **Status** banner: not configured / connected / ready / login expired → Reconnect / credentials unreadable.
  2. **1. GoTo OAuth client:**
     - instructions to create the client at developer.goto.com;
     - the redirect URI with a Copy button;
     - the required scopes listed;
     - "the secret is shown only once" note;
     - client ID and secret inputs. The secret is write-only, with placeholder "saved — leave blank to keep".
     - Fields whose source is `options`/`env` are disabled and labeled "set by config".
  3. **2. Connect:** a button that POSTs `api/connect`, then `location.href = url`. On `?error=goto_login`, it explains: "GoTo shows the same error for an unregistered redirect URI or a scope not enabled on the client — check both."
  4. **3. Sending number:** an account `<select>`, then a number `<select>` grouped by account, a typed-number fallback if listing fails, and the `smsEnabled` hint.
  5. **4. Test:** a phone input, **Send test text**, and the result reason shown verbatim.
  6. **5. Incoming texts:** radio buttons Webhook (disabled unless `canWebhook`, with a Super Admin note) / Polling / Off, plus GoTo error text shown verbatim.
  7. **6. Activity:** the last 50 log entries, and the opt-out list with remove/add.
  8. Footer: `goto-sms v{version} · unofficial, not affiliated with GoTo`.
- Light and dark themes via `prefers-color-scheme`. Works at 360 px width. Labels on every input. Status changes are announced in an `aria-live="polite"` region.

- [ ] **Step 1:** Write the failing tests with `express()` + `fetch` against a listening server:
  - `GET /goto-sms/ serves html containing 'goto-sms v'`.
  - **`page has no absolute /goto-sms/ or /api/ URLs`**: assert `!/["'](\/goto-sms|\/api)\//.test(html)` (Review Focus 5).
  - `JSON body round-trip through POST /api/credentials`.
  - `webhookRouter() exposes only /inbound`.
  - `baseUrl mismatch warns once`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Build the page, the build script and the router.
- [ ] **Step 4:** Run `npm run build && npm test`: PASS.
- [ ] **Step 5:** Commit `feat: shared setup page and Express router`.

### Task 14: Example app and browser smoke test

**Files:**
- Create `examples/express-app/{package.json,server.mjs,Dockerfile,README.md}`, `e2e/setup.spec.ts` and `playwright.config.ts`.
- Create `test/helpers/fake-goto-cli.ts`, which runs the fake standalone on a fixed port for e2e.

**Interfaces:** Consumes the public API only (`import { createGoToSms } from '@oneofthegeeks/goto-sms'` through the workspace link).

The example (`server.mjs`):
- An Express app on `PORT` (default 3000) that mounts `/goto-sms`.
- `authorize` checks HTTP Basic against `ADMIN_PASSWORD`.
- `POST /send {to,text}`.
- It logs inbound messages.
- It honors `GOTO_SMS_AUTH_BASE_URL` / `GOTO_SMS_API_BASE_URL` for e2e.
- Dockerfile: multi-stage `node:22-slim`, `USER node`, and a `HEALTHCHECK` on `/goto-sms/api/status`. The status call returns 403 without auth, so the healthcheck uses a separate `GET /healthz` returning `{ok:true, version}`.

The fake needs `GET /oauth/authorize?…&redirect_uri&state`, which redirects to `redirect_uri?code=code-ok&state=…`.

- [ ] **Step 1:** Write `e2e/setup.spec.ts`, which runs against the fake and the example:
  1. Open `/goto-sms/` with basic auth.
  2. Enter `cid`/`csecret` and save.
  3. Click Connect and land back on the page with "connected".
  4. Choose the account, then the number.
  5. Send a test to `+18015550199` and see "sent".
  6. Check that the fake `sent` length is 1, at 360 px and at desktop width.
- [ ] **Step 2:** Run `npx playwright test`: FAIL until wiring is complete; then fix until PASS.
- [ ] **Step 3:** Add an `e2e` job to `ci.yml` (Node 22, `npx playwright install --with-deps chromium`).
- [ ] **Step 4:** Commit `test: example app and browser smoke test`.

### Task 15: Docs, conformance map, publish workflow, 0.1.0

**Files:**
- Create `contract/conformance.md` and `.github/workflows/publish.yml`.
- Modify `README.md`, `packages/node/README.md`, `CLAUDE.md` and `CHANGELOG.md`.

- [ ] **Step 1:** Write `contract/conformance.md`: for C1–C23, the spec wording and the Node test name(s) that prove it. Every C-number must map to at least one test name found in `packages/node/test/`. Check with a grep loop that every listed test name exists.
- [ ] **Step 2:** Write `packages/node/README.md` (it ships to npm), with these sections:
  - the unofficial disclaimer (first line);
  - 60-second quick start (the spec's code sample);
  - creating the GoTo OAuth client (redirect URI, scopes, secret shown once);
  - env vars table and precedence (including "GOTO_REFRESH_TOKEN seeds, then the store manages it");
  - incoming: webhook vs polling (Super Admin, public https);
  - STOP/START/HELP;
  - `SendResult` statuses table;
  - storage (file default, SQLite, custom store interface);
  - **one process per store, never share a store between apps** (refresh rotation logs the other out);
  - 10DLC: "the test send is the real proof";
  - troubleshooting (GoTo's generic login error has two causes; 403 meanings).

  The root `README.md` gives the project overview and links to `contract/`.
- [ ] **Step 3:** Write `publish.yml`:
  - on push of tags `v*`;
  - job `publish` with `environment: npm` (Taylor adds the required-reviewer rule) and `permissions: id-token: write, contents: write`;
  - `npm ci && npm run build && npm test`, then `npm publish -w packages/node --provenance --access public`;
  - then zip `setup-ui/dist` as `goto-sms-setup-ui-${tag}.zip` and attach it to a GitHub release (`gh release create`).
- [ ] **Step 4:** Update `CLAUDE.md`: fill in Testing (the real suites) and Key Files; add one line, "Live: not yet published". Add a `CHANGELOG.md` entry for 0.1.0.
- [ ] **Step 5:** Run `npm run typecheck && npm run lint && npm run build && npm test && npx playwright test`: all pass. Run `npm pack -w packages/node --dry-run`: it lists only `dist/**`, README, LICENSE and package.json; check that the tarball has no `test/` or `.ts` source except `.d.ts`.
- [ ] **Step 6:** Commit `docs: README, conformance map and publish workflow for 0.1.0`.
- [ ] **Step 7 (Taylor, manual):**
  1. Create the public GitHub repo `oneofthegeeks/goto-sms` and push.
  2. Run `npm login`, then `npm publish -w packages/node --access public` for the first 0.1.0 publish.
  3. On npmjs.com, add the trusted publisher (repo `oneofthegeeks/goto-sms`, workflow `publish.yml`, environment `npm`).
  4. Add the `npm` environment with Taylor as required reviewer.

  Later versions publish from tags. Before 1.0, run the live check from the spec's Testing section.
