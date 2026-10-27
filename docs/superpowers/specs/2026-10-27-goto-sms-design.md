# goto-sms — design

Date: 2026-10-27 · Author: Taylor (oneofthegeeks) with Claude · Status: draft for approval

## Intent

Taylor has hand-built GoTo Connect texting into roughly ten apps (party-invites, swu-ideas,
geekonomics-app, geeks-tracker, utv-tracker, haunted-control, shop-pureskinutah, SMS-APP,
goto_demo_scripts, ha-goto). Each copy re-solved the same problems: OAuth, keeping the refresh
token alive, an account picker, a sending-number picker, E.164 cleanup, inbound texts and STOP.
Each copy also fixed a different subset of the bugs.

The goal is to build this **once, correctly**, and publish it so that **GoTo customers and
developers** can install it and have texting work in their app. A developer pastes their own
client ID and secret into a setup page, clicks Connect, picks an account and number, and sends.
They never need to learn GoTo's OAuth quirks.

The project is **unofficial and published by Taylor personally**, not by GoTo. Node comes first.
The same design is meant to repeat in other languages (Python next, then whatever customers ask
for). Taylor will add features as real use turns up gaps.

## Shape: a family, Node first

| Piece | What | Shared across languages? |
|---|---|---|
| **Core client** | OAuth, token refresh, accounts/numbers discovery, send, receive, STOP | Re-implemented per language |
| **Setup page** | One self-contained static web page (HTML+JS+CSS, no framework at runtime) | **Yes. Built once, bundled into every language package** |
| **HTTP contract** | The small set of JSON endpoints the setup page calls, plus the OAuth callback and inbound webhook | **Yes. Written as a spec; every language implements it** |
| **Conformance checklist** | The gotchas below as a list of required behaviours, each with a test in every language | **Yes** |

This design covers the Node package in full, plus the three shared pieces. Python
(extending the existing `aiogotoconnect` on PyPI) and other languages are separate later projects.
They reuse the setup page, the contract and the checklist.

## Names and publishing

- GitHub repo: `oneofthegeeks/goto-sms`. **Public**, an exception to Taylor's private-by-default
  rule, because others must be able to read it. Checked 2026-10-27: the name is free. The local
  folder `~/dev/goto-sms-app` becomes this repo.
- npm package: `@oneofthegeeks/goto-sms`. Checked 2026-10-27: no such package, and bare `goto-sms`
  is also free. **Taylor needs an npm account named `oneofthegeeks`** (or an npm org of that name)
  to own the scope. This box is not logged in to npm.
- License: MIT (same as aiogotoconnect).
- README states clearly: *unofficial, not affiliated with or endorsed by GoTo*. Following the
  aiogotoconnect precedent, the name avoids looking like an official GoTo product.
- Releases follow the aiogotoconnect model:
  - Tag `vX.Y.Z` (admin-only).
  - GitHub Actions `publish.yml` runs.
  - The `npm` environment pauses for Taylor's manual approval.
  - The package is published with npm trusted publishing (OIDC, provenance).
  - `main` is PR-only, with CI required.
  - It is a library, so there is no Docker image and no Poppy deploy. An `examples/` app has a
    Dockerfile for trying it out.

## Developer experience (the success test)

```bash
npm install @oneofthegeeks/goto-sms
```

```js
import express from 'express';
import { createGoToSms } from '@oneofthegeeks/goto-sms';

const app = express();
const sms = createGoToSms({
  publicUrl: 'https://myapp.example.com',      // used for OAuth redirect + webhook
  dataDir: './data',                          // default store location
  authorize: (req) => req.user?.isAdmin,      // who may open the setup page (required)
});
app.use('/goto-sms', sms.router());           // setup page + callback + webhook

sms.on('message', (msg) => console.log(msg.from, msg.text));
await sms.send('+15551234567', 'Hello');      // anywhere in their code
```

Then the developer opens `/goto-sms`:
1. The page tells them exactly what to create at developer.goto.com:
   - the redirect URI to register (shown with a copy button);
   - the scopes to tick on the client;
   - a note that the client secret is only shown once.
2. They paste the client ID and secret. Both are saved encrypted, and the secret is never shown
   again (write-only; a blank field keeps the stored value).
3. They click **Connect** and sign in to GoTo.
4. They pick an **account**, then a **sending number**. The numbers are grouped by account, and
   there is a typed fallback if listing fails.
5. They click **Send test text** to their own phone. Because nothing in the API reliably says a
   number is SMS/10DLC-ready, this is the real proof.
6. They turn on **incoming texts**, using webhook or polling (see below).
7. A status panel shows four states: not configured / connected / ready / login expired (reconnect).

**Done means:** a stranger with a GoTo account and an OAuth client goes from `npm install` to a
delivered test text without reading GoTo's docs, and an incoming reply shows up in their handler.

## Goals

- Send texts from any Node app with one call. The call returns a clear result object instead of
  throwing for expected outcomes: `sent`, `opted_out`, `invalid_number`, `uncertain`,
  `not_connected`, `rejected` (with a human-readable `reason`).
- Provide a setup UI that works whatever the host app's frontend is, or with no frontend at all.
- Receive incoming texts in v1, with built-in STOP/START/HELP handling.
- Encode every gotcha below as a tested behaviour.
- Ship TypeScript types and good autocomplete.

## Non-goals (v1)

- Voice calls (aiogotoconnect covers voice for Python).
- MMS / pictures.
- Bulk campaigns, scheduling and templates. The host app owns those. The package sends one text
  to one person per call; looping is the caller's job.
- Frameworks other than Express in v1. The core is framework-free, so a Fastify/Koa/Next adapter
  is a later addition. The router is a thin wrapper over plain `(req, res)` handlers, which keeps
  that cheap.
- Multi-tenant (several GoTo logins in one app). This is the main later extension
  (geekonomics-app needs per-company credentials). v1 stores one connection, but the store API
  takes a `tenant` key (default `"default"`) so adding multi-tenant later does not break callers.
- Countries other than US/Canada for number normalization. E.164 input with `+` passes through,
  but only NANP numbers are cleaned up from loose input.

## Anti-goals (would make it a failure even if it "works")

- **Reporting a text as sent when it wasn't.** This was the shop-pureskinutah bug. Dev "log only"
  mode must be explicit, and it refuses to run when `NODE_ENV=production`.
- **Texting someone who replied STOP.**
- **Silently double-sending.** This covers retrying a send whose outcome is uncertain, and a cron
  job that runs twice.
- **Leaking credentials.** That means secrets in logs, secrets returned to the browser, or a setup
  page reachable by anyone.
- **Breaking a host app's install** with native-compile dependencies. The default must be
  pure JS.
- **Looking like an official GoTo product.**

## Core behaviour

### OAuth

- Authorization-code flow against `https://authentication.logmeininc.com/oauth/authorize` and
  `/oauth/token`.
- **No `scope` and no `prompt` in the authorize URL.** Scopes come from the client's
  configuration. Naming a subset makes GoTo's login page fail with a generic "looks like there is
  a problem".
- The token endpoint uses **HTTP Basic** client auth with a form-encoded body.
- **Connect is a POST** that returns the authorize URL; the page then navigates to it. This stops a
  link preloader from overwriting the saved state.
  - `state` is random, single-use, expires after 10 minutes, and is compared in constant time.
  - Several pending states are allowed, so two tabs don't break each other.
- The access token is cached and reused until 60 s before it expires.
- **Single-flight refresh:** concurrent callers share one in-flight refresh promise.
- **Refresh-token rotation:** save the new refresh token whenever the response includes one, and
  otherwise keep the old one.
- Failure classes:
  - **Login dead:** a refresh answered 400/401/403. Mark `login_expired`, stop trying, and show
    "Reconnect" in the UI.
  - **Temporary:** 408/429/5xx or a network timeout. Retry the refresh with backoff, and keep the
    connection.
- If the redirect fails, the setup page explains the two common causes: the redirect URI isn't
  registered on the client, or a scope isn't enabled.

### Required client scopes (shown on the setup page)

- `messaging.v1.send`: required.
- `messaging.v1.read`: incoming by polling, and some lookups.
- `messaging.v1.notifications.manage`: incoming by webhook.
- `voice-admin.v1.read`: the phone-number dropdown.
- *Builder to verify:* which scope (if any) `identity/v1/Users/me` needs. party-invites calls it
  successfully with the three messaging scopes.

### Accounts and numbers

- **Accounts:** `GET https://api.goto.com/identity/v1/Users/me` returns them in
  `["urn:scim:schemas:extension:getgo:1.0"].accounts[]` (`value` = account key, plus a display
  name). There is no top-level accountKey.
- **Numbers:** `GET https://api.goto.com/voice-admin/v1/phone-numbers?accountKey=…&pageSize=100`,
  following `pageMarker` until it runs out, de-duplicated. The swu-ideas
  `src/server/sms.ts:listNumbers` is the reference.
- Saved selection: `accountKey` and `fromNumber` (E.164).
- `smsEnabled` from voice-admin is **not** a reliable "can text" signal. It is shown as a hint
  only, and the test send is the proof.

### Sending

- Endpoint: `POST https://api.goto.com/messaging/v1/messages` with
  `{ ownerPhoneNumber, contactPhoneNumbers: [to], body }`.
- **Normalize to E.164:**
  - NANP numbers get NANP validation (geekonomics-app `lib/phone.js`).
  - Input with a leading `+` passes through after basic validation.
  - Invalid input returns `invalid_number` with no network call.
- **Refuse to text the sending number itself.** GoTo returns a confusing permission-like error.
- **Opt-out gate:** a number on the opt-out list returns `opted_out` with no network call.
- **Dedupe:** `send(to, text, { dedupeKey })`. If the key has already produced `sent` or
  `uncertain`, return the earlier result without sending again.
- Body length: no silent truncation. Over 1,600 characters, return `rejected` with a reason.
  *Builder to verify GoTo's actual limit.* Existing apps truncated at 320/480; v1 should not
  silently cut a message.
- Timeout: 10 s by default. **A timeout or network error after the request was sent is
  `uncertain`, and is never retried automatically.**
- Error translation into readable `reason`s:
  - 401: retry once after a forced token refresh, and if it fails again, `login_expired`.
  - 403: missing `messaging.v1.send` scope, or the number isn't SMS-enabled in GoTo Admin.
  - A 10DLC/"campaign" error: the number isn't registered to a 10DLC campaign (see the swu-ideas
    message).
  - 429/5xx: `rejected` with a retryable flag. The caller may retry, because these responses mean
    GoTo did not accept the message.
- Two forms: `send()` returns a result and never throws for expected outcomes, while
  `sendOrThrow()` is for flows like verification codes.
- Every attempt is recorded in a message log (direction, to/from, status, reason, GoTo message id,
  timestamp). The log is capped and pruned after 90 days by default.

### Incoming texts

`sms.on('message', handler)` receives
`{ id, from, to, text, receivedAt, accountKey, raw }`. The handler errors are caught and logged,
and they never crash the receiver.

There are two modes, chosen on the setup page. The default is webhook when `publicUrl` is https,
otherwise polling.

**Webhook**
- The package does the GoTo setup itself, the way party-invites
  `docs/notes/texting.md` describes:
  1. Reuse a Webhook notification channel whose URL matches ours; otherwise create one with
     `channelType: "Webhook"` (an empty body returns 400).
  2. `POST /messaging/v2/subscriptions?accountKey=…` with the account key in **both** the query
     and the body. Try `ownerEntityType: ACCOUNT`, then `ORGANIZATION`.
  3. Requires a **Super Admin** login. The page says so, and shows GoTo's error verbatim if it
     refuses.
- The webhook URL is `<mount>/inbound/<secret>`. GoTo doesn't sign webhooks, so the path secret is
  the auth. It is compared in constant time and a wrong secret gets a 404.
- The route answers **204 immediately**, then processes the message.
- The envelope is parsed loosely: `content.payload.authorTouchpoint` and friends.
- Turning incoming off removes the subscription and rotates the secret.

**Polling**
- Every 30 s (configurable): `GET /messaging/v1/conversations?ownerPhoneNumber&oldestTimestamp`,
  then the messages per conversation. This follows the geeks-tracker `server/sms.js` pattern.
- A cursor plus a set of seen ids prevents duplicates. Timestamps are compared with `Date.parse`,
  because GoTo mixes µs and ms precision.
- Polling only runs while the process is up. On startup it catches up from the cursor.

**Both modes**
- Dedupe by GoTo message id.
- Limit incoming texts to 10 per hour per number; anything over the limit is logged and dropped.

### STOP / START / HELP (always on)

- The keyword is the whole message, trimmed and case-insensitive.
- **STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT:** add the number to the opt-out list and send one
  confirmation. The confirmation goes out even though the number is now opted out; this is the one
  allowed send.
- **START, UNSTOP, YES:** remove the number from the opt-out list and confirm. *My call:* include
  `YES`, because carriers commonly treat it as opt-in. A developer can turn that off.
- **HELP, INFO:** reply with configurable help text.
- The reply text for all three can be configured, with sensible defaults.
- Keyword messages are still emitted to `on('message')` with `msg.keyword` set. The host app sees
  them but doesn't have to act.
- `sms.optOuts.list() / add() / remove()` are available for admin screens.

## Storage

- A store interface: `get(tenant, key)`, `set(tenant, key, value)`, plus small append/query methods
  for the message log, opt-outs and dedupe keys.
- **Default: a pure-JS file store** in `dataDir`: a JSON file written atomically (write to a temp
  file, then rename). Log pruning keeps it small. *My call:* I earlier said SQLite by default; a
  file store avoids the native-compile `better-sqlite3` dependency that breaks installs (an
  anti-goal).
- **Built-in SQLite adapter** for apps that already use `better-sqlite3` (an optional peer
  dependency, WAL, sync API). This covers Taylor's own apps.
- **Custom store:** apps pass their own implementation for Postgres, etc.
- **Secrets at rest:** the client secret and the tokens are encrypted with AES-256-GCM.
  - The key comes from `GOTO_SMS_ENCRYPTION_KEY`.
  - If that is unset, a key file is generated in `dataDir` with mode 0600, and the page shows a
    warning to set the env var in production.
- **Never share a store between two running apps.** Refresh-token rotation means they would log
  each other out. The README states this, and the package detects it where it can: a refresh that
  fails right after another process rotated the token logs an explicit hint.

## Setup page and HTTP contract (shared across languages)

- The page is one static HTML file plus JS and CSS, built at package build time and shipped in the
  package. It uses relative URLs, so it works under any mount path. It ships in light and dark
  themes, is accessible, and works at phone width.
- `authorize(req)` is a **required** option. Without it, `router()` throws at startup, unless
  `allowUnauthenticatedSetup: true` is passed in development. The callback and the inbound webhook
  are exempt, because they are authenticated by `state` and the path secret.
- Every state-changing endpoint needs a same-origin check (`Origin`/`Sec-Fetch-Site`) and is a
  POST with a JSON body. That is enough CSRF protection, because the page is same-origin and the
  host's `authorize` already ran.
- Endpoints, relative to the mount. The builder writes these up in `contract/http.md`, which is the
  language-neutral spec:
  - `GET  /` (setup page)
  - `GET  /api/status`: `{ configured, connected, loginExpired, account, fromNumber, incoming: {mode, active}, redirectUri, webhookUrl? , version }`.
    It never returns secrets.
  - `POST /api/credentials` `{ clientId, clientSecret? }`
  - `POST /api/connect`: returns `{ url }`.
  - `GET  /callback`: the OAuth redirect. It goes back to `/` with a success or error notice.
  - `POST /api/disconnect`
  - `GET  /api/accounts`
  - `GET  /api/numbers?accountKey=`
  - `POST /api/selection` `{ accountKey, fromNumber }`
  - `POST /api/test` `{ to }`: returns the send result.
  - `POST /api/incoming` `{ mode: "webhook"|"polling"|"off" }`
  - `GET  /api/log?limit=`: recent message log.
  - `GET  /api/opt-outs`, and `POST /api/opt-outs` `{ number, action: "add"|"remove" }`
  - `POST /inbound/:secret`: the GoTo webhook.
- The page footer shows the package version (Taylor's "every app shows its version" rule).

## Conformance checklist (each item is a test in every language)

1. No `scope`/`prompt` in the authorize URL.
2. The token call uses Basic auth with a form body.
3. Connect is a POST; `state` is single-use, has a TTL, and is compared in constant time.
4. Refresh is single-flight, and a rotated refresh token is saved while an absent one keeps the
   old.
5. Refresh 400/401/403 means `login_expired`; 408/429/5xx and timeouts are temporary.
6. Accounts come from the Users/me SCIM getgo extension.
7. Numbers are paged with `pageMarker` and de-duplicated.
8. Phone numbers are normalized to E.164 with NANP validation; invalid input never reaches the
   network.
9. Sending to the owner number is refused.
10. An opted-out number is refused before the network.
11. `dedupeKey` prevents a second send.
12. A timeout after send returns `uncertain`, with no retry.
13. A 401 on send forces one refresh and one retry.
14. 403 and 10DLC errors are translated to readable reasons.
15. "Sent" is never reported when the package isn't configured; log-only mode refuses production.
16. The webhook checks the path secret in constant time, answers 204 first, and parses the
    envelope loosely.
17. The channel needs `channelType`, and an existing channel is reused.
18. The subscription carries `accountKey` in the query and the body, and falls back from ACCOUNT to
    ORGANIZATION.
19. Polling dedupes, and compares timestamps with `Date.parse`.
20. STOP/START/HELP behave as described, with the single STOP confirmation allowed.
21. Incoming texts are limited to 10/hour/number.
22. Secrets never appear in API responses or logs, and are encrypted at rest.
23. The setup page is unreachable without `authorize`.

## Testing

- `node:test` (Taylor's default for new Node projects).
- A **fake GoTo** in-process HTTP server stands in for authentication.logmeininc.com and
  api.goto.com. The base URLs are configurable, and `fetch` can be injected. No test touches the
  real GoTo.
- Every conformance item has at least one test.
- An HTTP-contract test suite drives the router with real HTTP. Later languages port this suite.
- A browser smoke test (Playwright) of the setup page against the fake GoTo: connect, pick, send
  test.
- **Live check (manual, before 1.0):** `examples/express-app` against Taylor's real GoTo
  client: connect, send to Taylor's phone, reply HELP, reply STOP, then confirm that a send is
  blocked.
- Lint and typecheck follow Taylor's TS baseline: oxlint `--type-aware` + prettier, and a strict
  tsconfig with `noUncheckedIndexedAccess`.

## Constraints

- Node ≥ 20. Uses global `fetch` and `crypto`; no runtime HTTP dependencies.
- TypeScript source. Ships ESM and CJS builds plus `.d.ts`.
- Express is a **peer dependency** (v4 and v5). `better-sqlite3` is an optional peer dependency.
- Zero native dependencies by default.
- Logs go through an injectable logger (default `console`, silenceable). They never contain
  tokens, secrets or full message bodies at info level.

## Repo layout (suggested; builder may adjust)

```
goto-sms/
  packages/node/          # @oneofthegeeks/goto-sms
  setup-ui/               # the shared static page (built into each package)
  contract/http.md        # language-neutral endpoint spec
  contract/conformance.md # the checklist above
  examples/express-app/   # runnable demo (+ Dockerfile)
  docs/superpowers/specs/ # this file
```

A monorepo, so the shared page and contract sit next to the first implementation. Later
languages may live here (`packages/python`, ...) or in their own repo. aiogotoconnect stays in
its own repo and pulls in the built setup page.

## Settled after builder review

- **Processes:** v1 supports **one running process per store**. It is documented, and a lock
  file / lease in the store warns when a second process starts. The store interface still ships
  with atomic `compareAndSet(tenant, key, expected, next)` and `claim(tenant, key, ttlMs)` now,
  and refresh, dedupe and OAuth `state` use them. Multi-process support (PM2 cluster, several
  containers) can therefore come later without breaking custom stores. Poller election waits for
  that later work.
- **STOP is durable and rate-limit-exempt:**
  - The webhook writes the raw inbound to the store *before* answering 204. That write is the
    whole synchronous work.
  - Processing happens after the 204. Unprocessed rows are replayed on startup, and dedupe by GoTo
    message id makes replays safe.
  - STOP/START keywords are handled *before* the 10/hour limit.
  - `on('message')` is at-least-once, deduped by `id` within the log window.
- **Config from env vars or options, as well as the setup page (Taylor, 2026-10-27): config wins.**
  - The sources, highest precedence first:
    1. `createGoToSms` options;
    2. env vars `GOTO_CLIENT_ID`, `GOTO_CLIENT_SECRET`, `GOTO_ACCOUNT_KEY`, `GOTO_FROM_NUMBER`,
       `GOTO_REFRESH_TOKEN`;
    3. values saved through the setup page.
  - Values from config show on the page as locked, with the label "set by config", and are never
    written to the store.
  - `/api/status` reports a `source` for each field.
  - `GOTO_REFRESH_TOKEN` only **seeds** the store. Once a rotated token has been saved, the stored
    token wins, because an env token can't be updated and rotation would otherwise break it on the
    next restart. The page shows "seeded from env, now managed".
  - This lets Taylor's existing Infisical-rendered apps move over without reconnecting.
  - Fully env-configured hosts can skip mounting the router entirely, unless they want incoming
    webhooks; a webhook-only router is available.
- **Multi-tenant (later):** one `createGoToSms({ tenant })` instance per tenant, each with its own
  router mount. v1's API doesn't change; `tenant` defaults to `"default"`.
- **Setup page distribution:** each release attaches `goto-sms-setup-ui-vX.Y.Z.zip` as a GitHub
  release asset. The Node package bundles it at build time, and other languages vendor that zip
  at their own build.
- **Release path:**
  - The plan ends at a tested repo plus a **0.1.0 on npm**.
  - The first publish is done by hand by Taylor once he has the npm account; trusted publishing is
    configured after that.
  - 1.0 comes after the live check against Taylor's real GoTo client.

## Calls made by Claude (Taylor to check)

- Default store is a pure-JS file store, not SQLite, because native deps break installs. A SQLite
  adapter is included.
- `YES` counts as an opt-in keyword (can be turned off).
- No silent truncation; over 1,600 characters is rejected.
- Repo is public, an exception to the private default.
- Express-only router in v1; the core is framework-free.
- Multi-tenant is deferred, but the store is keyed by tenant now.
- Monorepo layout with the shared page and contract alongside the Node package.

## Left to the builder

- Exact build tooling (tsup or similar) and the setup-page tech. Plain TS + a tiny bundler is
  fine; the page must not pull a framework into the runtime package.
- Exact wording of help text and error reasons.
- Confirming GoTo's real body length limit and the scope that `Users/me` needs, against the live
  API, before 1.0.
