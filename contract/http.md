# goto-sms HTTP contract

The language-neutral spec for the routes a goto-sms package mounts: the setup page, its JSON API,
the OAuth callback, and the GoTo webhook. Every port (Node first, then Python and others)
implements exactly this. The Node reference is `packages/node/src/server/handlers.ts`.

## Conventions

- All paths are relative to the mount point the host chooses (Node default `/goto-sms`). The setup
  page uses relative URLs only, so it works under any mount, including nested paths behind a proxy.
- The OAuth redirect URI is `publicUrl + mountPath + "/callback"`. For example,
  `https://x.example` mounted at `/admin/tools/sms` gives
  `https://x.example/admin/tools/sms/callback`.
- The webhook URL is `publicUrl + mountPath + "/inbound/" + secret`.
- `publicUrl` loses any trailing slash and `mountPath` is normalized to a leading slash with no
  trailing slash; the root mount (`/` or empty) becomes `""`, so mounting at the root gives
  `https://x.example/callback`, never `//callback`.
- Request bodies are JSON objects (at most 100 kB); a missing body counts as `{}`.
- A request for the mount itself without a trailing slash (`/goto-sms`) is redirected (`302`) to
  `./goto-sms/` (the last path segment plus `/`, query kept), so the page's relative URLs resolve
  under the mount. The Location is relative so it survives a proxy that strips a path prefix.
- `HEAD` is answered as `GET` (headers only), except `HEAD /callback`, which answers `200` with no
  body and no side effect, so a link prefetcher can't consume the single-use OAuth state.
- JSON responses use `200` unless stated. Header names are matched case-insensitively.

## Authentication

| Route                      | `authorize(req)` | Same-origin check | Authenticated by       |
| -------------------------- | ---------------- | ----------------- | ---------------------- |
| `POST /inbound/:secret`    | exempt           | exempt            | path secret            |
| `OPTIONS /inbound/:secret` | exempt           | exempt            | path secret            |
| `GET /callback`            | exempt           | exempt            | single-use OAuth state |
| every other `GET`          | required         | no                | host's `authorize`     |
| every other non-`GET`      | required         | required          | host's `authorize`     |

- `authorize(req)` is a required option. It receives the host framework's raw request and returns
  (or resolves to) a boolean. `false` gives `403 {"error":"forbidden"}`, except for `GET /` (the
  page) when the host set `loginUrl`: that request gets a `302` to `loginUrl` instead, so a person
  lands on the host's login. API routes always get the JSON `403`.
- `loginUrl` and `backUrl` accept only an absolute `http(s)` URL or a same-origin relative path.
  Anything else (`javascript:`, `data:`, protocol-relative `//host`, scheme-relative
  `http:host`, the literal `back`, values with whitespace) is refused when the package is created.
- Creating the handlers/router **throws** when no `authorize` is given, with this exact message:
  `goto-sms: pass authorize(req) to createGoToSms (or allowUnauthenticatedSetup: true in development)`.
  `allowUnauthenticatedSetup: true` skips `authorize`, but it also throws when
  `NODE_ENV === "production"`.
- **Same-origin check** (CSRF): passes when `Sec-Fetch-Site` is exactly `same-origin`, or when the
  host of the `Origin` header equals the `Host` header, or equals the host of `publicUrl` (for
  proxies that rewrite `Host`). A missing, unparseable or `null` Origin fails. A failure gives
  `403 {"error":"cross_origin"}`. Order: `authorize` first, then the same-origin check.
- The webhook and the callback are exempt from both, because GoTo and the OAuth redirect carry
  neither the host's session nor a same-origin header.

## Errors

Every JSON error is `{ "error": "<code>", "message": "<human text>" }`.

| Status | `error`                                                                                                               | When                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 400    | `invalid_input`, `invalid_number`, `invalid_inbound`, `not_configured`, `login_expired`, `bad_state`, `no_public_url` | the request can't be done as asked                     |
| 403    | `forbidden`, `cross_origin`                                                                                           | see Authentication                                     |
| 404    | `not_found`                                                                                                           | unknown route                                          |
| 409    | `locked`                                                                                                              | a field set by options/env was given a non-empty value |
| 413    | `too_large`                                                                                                           | the body is over 100 kB                                |
| 502    | `goto_api`                                                                                                            | GoTo answered with an error (body below)               |
| 503    | `temporary`                                                                                                           | GoTo timed out or the network failed                   |
| 500    | `internal`                                                                                                            | anything else; the message is generic                  |

A `goto_api` error carries GoTo's answer verbatim (truncated to 500 characters), so the page can
show, for example, a missing-scope 403:

```json
{
  "error": "goto_api",
  "message": "GoTo API error 403",
  "gotoStatus": 403,
  "gotoBody": "{\"message\":\"missing scope\"}"
}
```

Error details are logged at debug level only. Logs never hold tokens, secrets or message bodies at
info level or above.

## Secrets in responses

No response ever contains the client secret, an access token, or the refresh token. The webhook
secret appears in exactly one place: `incoming.webhookUrl` in the status payload of the HTTP routes,
which only the authorized admin can fetch and which the page shows so the admin can see where GoTo
delivers. A package's programmatic status call (Node: `sms.status()`) returns the same payload
**without** `incoming.webhookUrl`, because hosts may expose it without authorization.

## Status payload

Returned by `GET /api/status` and by every state-changing route marked "returns status".

```jsonc
{
  "version": "0.1.0", // package version
  "configured": true, // a readable client ID and client secret are available
  "connected": true, // a GoTo login is stored and not expired
  "loginExpired": false, // GoTo refused the refresh token; reconnect
  "credentialsUnreadable": false, // the stored client secret or GoTo login can't be decrypted (key changed); connected is then false
  "ready": true, // configured && connected && fromNumber set
  "clientId": "…", // optional
  "accountKey": "…", // optional
  "fromNumber": "+18015550100", // optional, E.164
  "invalidFromNumber": true, // optional: an options/env fromNumber isn't a phone number
  "sources": {
    // where each field comes from: "options" | "env" | "store" | "unset"
    "clientId": "store",
    "clientSecret": "store",
    "accountKey": "store",
    "fromNumber": "store",
  },
  "refreshSource": "login", // optional: "login" | "seeded-from-env"
  "redirectUri": "https://x.example/goto-sms/callback", // "" without a publicUrl
  "incoming": {
    "mode": "webhook", // "webhook" | "polling" | "off"
    "webhookUrl": "https://x.example/goto-sms/inbound/<secret>", // only in webhook mode, only over HTTP
    "canWebhook": true, // publicUrl is https
    "error": { "error": "goto_api", "message": "GoTo API error 403", "gotoStatus": 403 }, // optional, see below
  },
  "calls": {
    // optional: only when the host turned call watching on (see Calls)
    "watching": true, // a look at the call reports has run and the last one worked
    "error": { "error": "calls_scope", "message": "…", "gotoStatus": 403 }, // optional; same shape as incoming.error
  },
  "requiredScopes": [
    "messaging.v1.send",
    "messaging.v1.read",
    "messaging.v1.notifications.manage",
    "voice-admin.v1.read",
    // plus "cr.v1.read", last, only when call watching is on
  ],
  "back": { "url": "/admin", "label": "Spring Ideas" }, // optional: only when the host set backUrl; label defaults to "the app"
  "startupError": "…", // optional: only when startup failed; a fixed, secret-free reason in plain words
}
```

`incoming.error` is present when the account changed in webhook mode and moving the
subscription failed (see `POST /api/selection`): texts to the selected account are not arriving. It
carries the error code, its message and GoTo's HTTP status, never GoTo's body. It is cleared by the
next successful `POST /api/incoming` (any mode) or a successful move.

`calls` is present only when the host turned call watching on (Node: `watchCalls: true`; Python:
`watch_calls=True`) and the package started. `requiredScopes` lists `cr.v1.read` whenever call
watching is on (also when startup failed), and never otherwise. With watching off there is no `calls` key, no extra scope and no call-report
request. The rules are in [Calls](#calls). `calls` never carries a caller's number or caller ID.

The page renders `back` as a "← Back to <label>" link. If the package could not start (for
example no encryption key), the status still answers, with `back` as usual,
`configured`, `connected` and `ready` false, every source `"unset"`, and `startupError` saying why
(the package's own message, or only the error's name for anything else).

## Calls

Call watching is a host option, off by default; there is no route and no stored setting for it.
When it is on, the package polls GoTo's call reports and hands the host one `call` event per
inbound call to the sending number, and the status payload carries `calls` so the page can say
whether it works. Both packages keep the same state under the same store keys (`calls:cursor`,
`calls:since`, `calls:seen` as `[[id, ring, atMs], ...]`, `calls:error`), so a store written by
one reads correctly in the other.

- **Looks.** One look every call-poll interval (default 120 s), in every incoming mode, only once
  an account and a sending number are chosen. The first look saves the cursor and "watching since"
  as now, asks GoTo for the last minute (GoTo answers `400` to an empty window) and delivers
  nothing. Later looks read from the later of (cursor − 2 h) and (now − 24 h) up to now, every
  page; if paging is cut short the cursor is not advanced.
- **Which calls.** A call is delivered when its direction is `INBOUND`, the caller is a
  `PHONE_NUMBER` and the number dialled normalises to the sending number. When the summary does not
  say what was dialled, or what the caller is, the full report decides; if that fetch fails the
  call is left for the next look. Never delivered: outbound calls, calls to other numbers on the
  account, calls that started before watching was switched on, and a double ring (the same E.164
  caller with the same outcome within 120 s of a delivered call). A withheld or non-numeric caller
  is never a repeat.
- **Delivery is at least once.** The host's `call` handlers are awaited one at a time, in
  registration order, and the call is saved as seen only after they have all returned; a handler
  that fails is logged by the error's name and the rest still run. So a slow call handler holds up
  the next look and shutdown, which waits for a look in flight. (Node's `message` handlers are
  not awaited; this is the one place the two events differ.)
- **Failures** land in `calls.error` and nowhere else: none of them moves the cursor, marks the
  login expired or affects texting, and a good look clears the error.
  - `calls_scope`: GoTo answered `403`, or `401` again to a freshly refreshed token (`gotoStatus`
    says which). The message is fixed (below). The package then looks only once an hour, or as
    soon as the stored login changes (a reconnect or a renewed token). The warning is logged once.
  - `login_expired`: the login itself is dead (`loginExpired` is already true); no request is made.
  - `goto_api`: any other GoTo status, with `gotoStatus`.
  - `goto_unreachable`: the request failed or timed out.

  ```text
  GoTo refused the call reports. Enable the scope cr.v1.read on the OAuth client, then reconnect.
  ```

- **Privacy.** A caller's number and caller ID name never appear in a log line at info level or
  above, in the status payload, or on the page. Caller ID is the carrier's text: untrusted data.
- **The page** shows a Calls row on its summary only when `calls` is present: `Watching <number>`
  when `watching` is true, the error's `message` when there is an `error` (with a "Sign in again"
  button for `calls_scope`, which starts `POST /api/connect` over the live login), else `Starting…`.

## When startup failed

The routes still answer, so the admin can see why on the page. `authorize` and the same-origin
check apply as usual. `GET /` serves the page and `GET /api/status` the status above; every other
`/api/*` route gives `400 not_configured` with `startupError` as the message; `GET /callback`
redirects to `./?error=not_configured`; `POST /inbound/:secret` gives `404`.

## Routers

A package exposes two mountable routers:

- the full router (Node: `sms.router()`): every route below. Creating it throws without
  `authorize` (see Authentication). It can be created before startup finishes; requests wait.
- the webhook-only router (Node: `sms.webhookRouter()`): only `POST` and `OPTIONS /inbound/:secret`; every other
  request falls through to the host. It needs no `authorize`, because the webhook is exempt.

## Routes

### `GET /`

- Auth: `authorize`. Refused: `302` to `loginUrl` when the host set one, else `403`.
- Response: `200`, the setup page HTML.

### `GET /api/status`

- Auth: `authorize`.
- Response: the status payload.

### `POST /api/credentials`

- Auth: `authorize` + same-origin.
- Request: `{ "clientId"?: string, "clientSecret"?: string }`.
  - An empty `clientSecret` keeps the stored one (the page never echoes it back).
  - An empty value for a field set by options/env is skipped. The page posts only the fields it
    lets the admin edit, so a locked field arrives absent or empty and never conflicts.
  - A non-empty value for a field set by options/env gives `409 locked`; nothing is written.
- Response: the status payload.
- Errors: `400 invalid_input` (a field isn't a string), `409 locked`.

### `POST /api/connect`

- Auth: `authorize` + same-origin.
- Request: none.
- Response: `{ "url": "<GoTo authorize URL>" }`. The page navigates to it. The URL carries no
  `scope` and no `prompt`; its `state` is single-use and expires after 10 minutes.
- Errors: `400 no_public_url` (no publicUrl, so no redirect URI), `400 not_configured` (no client
  ID/secret, or the secret can't be decrypted).

### `GET /callback`

- Auth: exempt; authenticated by `state`.
- Query: `code`, `state`, or GoTo's `error`.
- Response: always `302` to the page:
  - success → `./?connected=1`;
  - GoTo sent `error` → `./?error=goto_login` (GoTo's text is never echoed; the page explains the
    two usual causes: the redirect URI isn't registered on the client, or a scope isn't enabled);
  - missing `code`/`state`, or an unknown, reused or expired state → `./?error=bad_state`;
  - any other failure → `./?error=<code>` (for example `login_expired` when GoTo refuses the code).

### `POST /api/disconnect`

- Auth: `authorize` + same-origin.
- Request: none. Deletes the stored login.
- Response: the status payload.

### `GET /api/accounts`

- Auth: `authorize`.
- Response: `{ "accounts": [{ "key": "<accountKey>", "name": "<display name>" }] }`.
- Errors: `400 not_configured` / `400 login_expired`, `502 goto_api`, `503 temporary`.

### `GET /api/numbers?accountKey=`

- Auth: `authorize`.
- Query: `accountKey` (required).
- Response:
  `{ "numbers": [{ "number": "+1…", "name": "…", "accountKey": "…", "smsEnabled"?: boolean }] }`,
  de-duplicated, in GoTo's order.
- Errors: `400 invalid_input` (no accountKey), plus those of `/api/accounts`.

### `POST /api/selection`

- Auth: `authorize` + same-origin.
- Request: `{ "accountKey"?: string, "fromNumber"?: string }`. `fromNumber` may be loosely
  formatted and is saved as E.164; an empty value clears a stored field.
- In webhook mode, when the selected account differs from the account the subscription is on, the
  subscription moves: the old one is deleted (the webhook secret, URL and channel are kept) and an
  `INBOUND_MESSAGE` subscription is made on the new account. If that fails the selection is still
  saved, the response is still `200`, and the status carries `incoming.error`.
- Response: the status payload.
- Errors: `400 invalid_number`, `400 invalid_input`, `409 locked`.

### `POST /api/test`

- Auth: `authorize` + same-origin.
- Request: `{ "to": string }` (required, loosely formatted is fine).
- Response: the send result, always `200`:
  `{ "status": "sent" | "opted_out" | "invalid_number" | "uncertain" | "not_connected" | "rejected", "reason"?, "retryable"?, "messageId"?, "to"? }`.
  The text is fixed: `Test message from goto-sms`. Opt-outs are honoured.
- Errors: `400 invalid_input` (no `to`).

### `POST /api/incoming`

- Auth: `authorize` + same-origin.
- Request: `{ "mode": "webhook" | "polling" | "off" }`.
- Behaviour; the stored mode changes only after the switch succeeded:
  - `webhook`: needs an https publicUrl and a selected account. Makes sure the webhook secret
    exists, then reuses a GoTo notification channel whose URL equals the current webhook URL or
    creates one, subscribes it to `INBOUND_MESSAGE` on the account, stops polling.
  - `polling` / `off`: when leaving webhook mode, deletes the subscription and rotates the webhook
    secret, so the old URL returns 404 from then on (the old channel is left on GoTo; a later
    enable creates a new one for the new URL). `polling` starts the poller; `off` stops it.
  - Switching from `webhook` to `polling` moves the poll cursor to now (the webhook covered the
    gap); from `off` the cursor is kept. A poll never reads further back than 24 hours before now;
    an older cursor is clamped and the clamp is logged at error level.
- Response: the status payload.
- Errors: `400 invalid_input` (bad mode), `400 no_public_url` (webhook without https publicUrl),
  `400 not_configured` (no account selected), `502 goto_api` with GoTo's body (for example a 403
  when the client lacks `messaging.v1.notifications.manage`).

### `GET /api/log?limit=`

- Auth: `authorize`.
- Query: `limit`, default 50, capped at 500; anything unparseable or below 1 means 50.
- Response: `{ "entries": [{ "id", "direction": "outbound" | "inbound", "from", "to", "status", "reason"?, "gotoId"?, "at" }] }`,
  newest first. Message bodies are never stored, so never returned.

### `GET /api/opt-outs`

- Auth: `authorize`.
- Response: `{ "optOuts": [{ "number": "+1…", "at": "<ISO time>", "source": "keyword" | "admin" }] }`,
  newest first.

### `POST /api/opt-outs`

- Auth: `authorize` + same-origin.
- Request: `{ "number": string, "action": "add" | "remove" }`. An added number gets source
  `admin`.
- Response: the opt-out list, as `GET /api/opt-outs`.
- Errors: `400 invalid_input` (bad action or no number), `400 invalid_number`.

### `OPTIONS /inbound/:secret`

- GoTo sends this to the webhook URL while creating the notification channel and refuses the channel
  (`400 Webhook URL did not respond as expected`) unless it gets a 2xx. It arrives **before** the
  stored mode is `webhook`, so the mode is not checked.
- Response, no body: `200` when the secret matches the stored webhook secret, else `404`.

### `POST /inbound/:secret`

- Auth: exempt; authenticated by the path secret, compared in constant time.
- Request: GoTo's webhook envelope (parsed loosely).
- Response (no body, except the `400` below):
  - `404` when incoming mode isn't `webhook`, or the secret is wrong;
  - `204` for anything that isn't an inbound text (GoTo sends other event types), for a
    duplicate of an already-received message, and for a text addressed to **another number** in
    the GoTo account (a subscription covers the whole account; only a known `to` that differs from
    the configured sending number is dropped, unstored and unprocessed);
  - otherwise the message is **persisted as pending first**, then `204` is returned, then it is
    processed (keywords, opt-outs, the host's `message` event) after the response. A processing
    failure leaves it pending for the background retry;
  - `400 {"error":"invalid_inbound"}` if the message can't be stored for lack of an id, sender or
    body.
