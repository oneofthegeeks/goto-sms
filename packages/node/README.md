Unofficial. Not affiliated with or endorsed by GoTo.

# @oneofthegeeks/goto-sms

Send and receive GoTo Connect SMS from a Node app. You paste your own GoTo OAuth client ID and
secret into a built-in setup page, click Connect, pick an account and a sending number, and send.
The package handles GoTo's OAuth quirks, token refresh, number cleanup, STOP/START/HELP and
inbound texts.

Requires Node 20 or newer. Express 4 or 5 is a peer dependency (only for `router()`); the core has
no runtime dependencies and no native modules. The type declarations reference `express` and
`better-sqlite3` types, so TypeScript projects without `skipLibCheck` also need `@types/express` and
`@types/better-sqlite3` installed.

## Quick start (60 seconds)

```sh
npm install @oneofthegeeks/goto-sms express
```

```js
import express from 'express';
import { createGoToSms } from '@oneofthegeeks/goto-sms';

const app = express();
const sms = createGoToSms({
  publicUrl: 'https://myapp.example.com', // used for the OAuth redirect and the webhook
  dataDir: './data', // default store location
  authorize: (req) => req.user?.isAdmin, // who may open the setup page (required)
});
app.use('/goto-sms', sms.router()); // setup page + callback + webhook

sms.on('message', (msg) => console.log(msg.from, msg.text));
await sms.send('+15551234567', 'Hello'); // anywhere in your code
```

Open `/goto-sms` in your browser. The page walks you through five steps, one at a time: create the
GoTo app (redirect URI and scopes with copy buttons), paste the client ID and secret, sign in to
GoTo, pick the sending number, **Send test text**, and choose how replies arrive. Once everything
works it shows a Ready summary with Change links, the recent activity and the opt-out list. Without `authorize`,
`router()` throws (pass `allowUnauthenticatedSetup: true` only in development). `mountPath`
(default `/goto-sms`) must match where you mount the router, because it is part of the redirect URI
and webhook URL.

`send()` returns a result instead of throwing for expected outcomes; `sendOrThrow()` throws
`SendFailedError` (carrying the result) for flows like verification codes. `send()` rethrows
startup errors other than `NotConfiguredError` (for example an unreadable store).

`sms.status()` returns the setup page's status (configured, connected, ready, incoming mode), for
a health check. Unlike the page's own `/api/status`, it leaves out the webhook URL, because that
URL contains the webhook secret. It reads stored state only and makes no GoTo call.

`await sms.verifyConnection()` checks the GoTo login for real: it gets a new access token now
(exchanging a `GOTO_REFRESH_TOKEN` seed if one is waiting, otherwise refreshing), then returns
`status().connected`. It never throws for login, configuration or GoTo problems; it returns `false`
and, for a refused login, `status()` says why (for example `loginExpired`). It also returns `false`
when GoTo or the network is down, because the login couldn't be checked; the stored login is kept
and `status().connected` may still be `true`. Use it to move a seeded login over at startup or
for a deeper health check. Each call makes one GoTo token request, so don't poll it every few
seconds.

`sms.core` is internal: it exists for the package's own route handlers and may change in any
release, including patch releases. Use the methods above instead.

### Fitting the page into your app

```js
const sms = createGoToSms({
  authorize: (req) => Boolean(req.cookies?.session), // req is your framework's request
  backUrl: '/admin', // adds "← Back to Spring Ideas" at the top of the page
  backLabel: 'Spring Ideas', // default 'the app'
  loginUrl: '/login?next=/goto-sms/', // where a signed-out visitor to the page is sent
});
```

- `authorize(req)` receives the framework's own request (Express: with `req.cookies`, `req.user`
  and so on, already typed loosely so you need no cast) and returns a boolean or a promise of one.
- `backUrl` / `backLabel`: a link back to your app at the top of the setup page.
- `loginUrl`: when `authorize` says no, a browser opening the page is redirected (302) here
  instead of getting a bare 403. The page's API routes still answer 403 JSON.
- `backUrl` and `loginUrl` must be an `http(s)` URL or a relative path (`/admin`, `../app`).
  `createGoToSms` throws for anything else, such as `javascript:`, `data:`, `//other-host`,
  `http:other-host` or the literal `back`.

## Create the GoTo OAuth client

At [developer.goto.com](https://developer.goto.com), create an OAuth client (authorization-code
grant):

1. **Redirect URI:** `<publicUrl><mountPath>/callback`, for example
   `https://myapp.example.com/goto-sms/callback`. The setup page shows the exact value with a copy
   button. It must match exactly.
2. **Scopes** (enable all of these on the client; the authorize URL deliberately names none):
   - `messaging.v1.send` (required)
   - `messaging.v1.read` (incoming by polling)
   - `messaging.v1.notifications.manage` (incoming by webhook)
   - `voice-admin.v1.read` (the sending-number dropdown)
3. **The client secret is shown only once.** Copy it before leaving the page. The setup page stores
   it encrypted and never shows it again (a blank field keeps the stored value).

## Configuration

Each setting can come from three places. Highest precedence first:

1. `createGoToSms` options
2. Environment variables
3. Values saved through the setup page

| Setting                   | Option          | Env var                   |
| ------------------------- | --------------- | ------------------------- |
| OAuth client ID           | `clientId`      | `GOTO_CLIENT_ID`          |
| OAuth client secret       | `clientSecret`  | `GOTO_CLIENT_SECRET`      |
| Account key               | `accountKey`    | `GOTO_ACCOUNT_KEY`        |
| Sending number (E.164)    | `fromNumber`    | `GOTO_FROM_NUMBER`        |
| Refresh token (seed only) | `refreshToken`  | `GOTO_REFRESH_TOKEN`      |
| Encryption key            | `encryptionKey` | `GOTO_SMS_ENCRYPTION_KEY` |
| Public base URL           | `publicUrl`     | `GOTO_SMS_PUBLIC_URL`     |

Blank values and the literal placeholder `CHANGEME` (any case) count as unset, in options and env
alike, so a secret manager's unfilled key never becomes a locked client ID or the encryption key.

**Upgrading from 0.1.x:** 0.1.x used a `CHANGEME` (or whitespace-only) `GOTO_SMS_ENCRYPTION_KEY` as
a real key. From 0.2.0 it is ignored and a warning is logged, so secrets saved under it can't be
read: set a real key, then paste the client secret again and reconnect on the setup page. Values from options or env show on the setup page as locked
("set by config") and are never written to the store.

`GOTO_REFRESH_TOKEN` **seeds, then the store manages it.** GoTo rotates refresh tokens, and an env
var cannot be updated, so once a rotated token has been saved the stored token wins. This lets an
existing app move over without reconnecting. A new `GOTO_REFRESH_TOKEN` cannot revive a login that
GoTo has already killed (for example a browser login that expired); use **Reconnect** on the setup
page instead.

Other options: `mountPath`, `backUrl`, `backLabel`, `loginUrl` (see above), `dataDir` (default `./data`), `store`, `tenant` (default `"default"`),
`logOnly`, `replies` (`{ stop, start, help }` text), `yesIsOptIn` (default true), `pollIntervalMs`
(default 30 s), `sendTimeoutMs` (default 10 s), `inboundPerHour` (default 10), `logRetentionDays`
(default 90), `logger` (default `console` without debug lines; pass your own `{ debug, info, warn, error }` to see them, or `false` to silence), `fetch`, `authBaseUrl`,
`apiBaseUrl`, `env`.

**Encryption key.** The client secret and tokens are encrypted at rest with AES-256-GCM. Set
`GOTO_SMS_ENCRYPTION_KEY` in production, and make it high entropy: it is hashed with SHA-256 with
no key-stretching, so a human-chosen password is weak. Generate one with:

```sh
openssl rand -base64 32
```

If it is unset, a key file (mode 0600) is generated in `dataDir` and a warning is logged. With a
custom `store` and no `dataDir`, the env var or `encryptionKey` is required.

## Incoming texts

`sms.on('message', handler)` receives `{ id, from, to, text, receivedAt, accountKey, keyword?, raw }`.
Handler errors are caught and logged. Delivery is at-least-once, deduplicated by GoTo message id.
Texts over 10 per hour per number are logged and dropped (STOP/START are exempt). Choose the mode on
the setup page.

- **Webhook** (default when `publicUrl` is https). The package creates or reuses a GoTo Webhook
  channel and subscription for you. This needs a **Super Admin** GoTo login, and the page shows
  GoTo's error verbatim if it refuses. Your server must be reachable over **public https**. The
  URL is `<mount>/inbound/<secret>`; GoTo does not sign webhooks, so the path secret is the
  authentication and a wrong secret gets a 404. The route answers 204 immediately, writes the raw
  message to the store first, then processes it (unprocessed rows are replayed on startup).
  `sms.webhookRouter()` mounts only this route and needs no `authorize`.
- **Polling** (works anywhere, including localhost). Every 30 s the package lists conversations and
  their messages. It only runs while your process is up, and catches up from its cursor on start.
  The first poll looks back 5 minutes, and no poll ever reads more than 24 hours back: after a
  longer gap the older texts are skipped and an error is logged. Switching from webhook to polling
  starts from now. Note: the polling endpoints are modeled on GoTo's
  documentation and another app, and have **not yet been verified against live GoTo**.

## STOP / START / HELP

Always on. A keyword is the whole message, trimmed and case-insensitive.

- **STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT**: the number is added to the opt-out list and
  gets one confirmation (the one allowed send to an opted-out number).
- **START, UNSTOP, YES**: removed from the list, with a confirmation. Set `yesIsOptIn: false` to
  stop `YES` counting.
- **HELP, INFO**: replies with the help text.

Reply texts are configurable with `replies`. Keyword messages are still emitted to
`on('message')` with `msg.keyword` set. `sms.optOuts.list() / add() / remove() / has()` back admin
screens. `send()` to an opted-out number returns `opted_out` without touching the network.

## `SendResult`

`send(to, text, { dedupeKey? })` resolves to `{ status, reason?, retryable?, messageId?, to?, deduped? }`.

| `status`         | Meaning                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sent`           | GoTo accepted the message (`messageId` set).                                                                                                     |
| `opted_out`      | The number replied STOP. Nothing was sent.                                                                                                       |
| `invalid_number` | Not a valid US/Canada or E.164 number. No network call.                                                                                          |
| `uncertain`      | The request may or may not have reached GoTo (timeout, network error, unreadable 2xx). **Never retried automatically**; check before resending.  |
| `not_connected`  | Not configured, or the GoTo login expired. Reconnect on the setup page.                                                                          |
| `rejected`       | Refused, with a human-readable `reason` (too long over 1,600 characters, the sending number itself, 403, 10DLC, 429/5xx with `retryable: true`). |

A `dedupeKey` that already produced `sent` or `uncertain` returns the earlier result with
`deduped: true` instead of sending again. Text is never silently truncated.

## Storage

- **File store (default):** a JSON file at `<dataDir>/goto-sms.json`, written atomically. Pure JS,
  no native modules.
- **SQLite:** for apps already using `better-sqlite3` 11, 12 or 13 (optional peer dependency,
  WAL). Versions 11 and 12 run on Node 20 or newer; 13 needs Node 22 or newer. You need
  `@types/better-sqlite3` installed for the `SqliteStore` types.

  ```js
  import Database from 'better-sqlite3';
  import { createGoToSms, SqliteStore } from '@oneofthegeeks/goto-sms';
  const sms = createGoToSms({ store: new SqliteStore(new Database('app.db')) /* ... */ });
  ```

- **Custom store:** implement `GoToSmsStore` (`get`, `set`, `delete`, `list(tenant, prefix)`,
  atomic `compareAndSet(tenant, key, expected, next)`, and `claim(tenant, key, ttlMs, owner)`) for
  Postgres or anything else. `runStoreConformance` from `@oneofthegeeks/goto-sms/testing` is the
  test suite your store should pass.

### One process per store

**Run one process per store, and never share a store between apps.** GoTo rotates the refresh
token on use, so a second process or app using the same login would log the other out. A process
lock in the store warns if a second process starts. The lock is a 90 s lease, so restarting
quickly can log a false "Another process is using this goto-sms store" warning; it is harmless.
Multi-process support (PM2 cluster, several containers) is not in 0.1.

## 10DLC

US carriers require business texting numbers to be registered to a 10DLC campaign. Nothing in
GoTo's API reliably says whether a number is SMS- or 10DLC-ready (`smsEnabled` is only a hint), so
**the test send is the real proof.** Use **Send test text** on the setup page before relying on a
number.

## Troubleshooting

- **GoTo's login page says "looks like there is a problem" (a generic error).** It has two
  causes: the redirect URI is not registered on the client exactly as shown on the setup page, or
  a scope is not enabled on the client. Check both. The package sends no `scope` or `prompt`
  parameter on purpose.
- **403 on send:** the login lacks `messaging.v1.send`, or the number is not SMS-enabled in GoTo
  Admin.
- **A 10DLC / "campaign" error:** the number is not registered to a 10DLC campaign.
- **Setup page says GoTo refused the saved login:** GoTo refused the refresh token. Click
  **Reconnect** in the "Sign in to GoTo" step.
- **Webhook setup fails with a 403:** the GoTo login that connected is not a Super Admin.
- **Nothing arrives by webhook:** the URL must be public https; try polling to confirm the rest.

## Testing your code

`@oneofthegeeks/goto-sms/testing` exports `runStoreConformance`. Pass `logOnly: true` in
development to run every gate (number cleanup, opt-outs, dedupe) without calling GoTo; it refuses
to start when `NODE_ENV=production`, so a log-only app can never claim a text was sent.

## License

MIT. Source and the language-neutral HTTP contract:
<https://github.com/oneofthegeeks/goto-sms>.
