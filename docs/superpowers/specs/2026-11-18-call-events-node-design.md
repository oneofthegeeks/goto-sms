# Call events in the Node package and on the setup page

Status: draft for Taylor's review, 2026-11-18. Target: `@oneofthegeeks/goto-sms` 0.3.0 (setup page 0.3.0).
Companion to the Python design, `aiogotoconnect` `docs/superpowers/specs/2026-11-18-call-events-design.md`, already
built (aiogotoconnect pull request #12) and running in Taylor's to-do board since 2026-11-18.

## Intent and why

The Python library can now tell an app when someone calls its GoTo sending number (`watch_calls=True`,
`sms.on("call")`). The two packages are meant to be the same thing in two languages, with one written contract and one
setup page. This brings Node level, writes the behaviour into the shared contract, and lets the setup page tell an
admin whether call watching works, because today a missing scope is visible only to code.

## Goals

- `createGoToSms({ watchCalls: true })` and `sms.on('call', handler)` in Node, behaving as Python does.
- The `calls` status key and its rules are part of `contract/http.md`, with conformance rows both packages map to tests.
- The setup page shows a Calls line when watching is on: working, or the exact fix when GoTo refuses.

## Non-goals

- A switch on the page. Watching stays a code option (Taylor, 2026-11-18: "show status only").
- New HTTP routes or stored settings.
- Anything the app does about a call (items, texts, caps): the host's.
- Push notifications for calls (GoTo's `REPORT_SUMMARY` subscription). Polling only, as in Python.
- Fixing Python's deferred minors (listed in pull request #12). They are ported as they are and fixed in both later.

## Anti-goals

- The two packages drifting: a behaviour that differs between Node and Python without a line in the contract saying so.
- The page nagging apps that do not watch calls: no Calls line, no extra scope, when `calls` is absent from status.
- Any change to texting behaviour, or an extra GoTo request, for hosts that do not opt in.
- Caller numbers or caller ID names in logs at info or above, or anywhere in the status payload or the page.

## Constraints

- Node >= 22, TypeScript strict, `node:test` against `test/helpers/fake-goto.ts`; `npm run typecheck && npm run lint &&
  npm test && npm run build` and `npm run e2e` green. `main` takes changes only by pull request.
- The setup page uses relative URLs only and is one inlined HTML file; Python vendors it byte for byte from a release
  (`scripts/update-setup-page.sh vX.Y.Z`), so Python can only pick the new page up **after** Taylor publishes 0.3.0.
- "Node behaviour wins when the two disagree" stays the rule, but here Python went first: where this port would differ
  from Python as built, change Python in the same round (a commit on pull request #12) rather than fork the behaviour.

## Approaches considered (the page)

1. **Status only (chosen by Taylor, 2026-11-18).** A Calls line on the manage view, driven by `status.calls`; the scope
   list gains `cr.v1.read` when watching is on. No routes, no stored setting.
2. **A switch on the page.** Needs a stored setting, a route, conformance rows and a Python change, and could be
   switched on in an app with no `on('call')` handler. Rejected for now; the design leaves room for it.
3. **Node only, no page change.** Leaves an admin with a missing scope no hint. Rejected.

## What the host sees (Node)

```ts
const sms = createGoToSms({ ...options, watchCalls: true });   // off by default
sms.on('call', async (call) => {
  if (call.outcome === 'MISSED') console.log(call.from, call.callerName, call.at);
});
```

| Option | Default | Notes |
|---|---|---|
| `watchCalls` | `false` | Poll call reports and emit `'call'`. Needs scope `cr.v1.read` on the OAuth client. |
| `callPollIntervalMs` | `120_000` | Milliseconds between looks. |

```ts
export interface InboundCall {
  id: string;            // GoTo's conversationSpaceId; delivery is at least once, key on this
  from: string;          // E.164 when it normalises, else GoTo's text cut to 20 chars; '' if withheld
  to: string;            // the number dialled: always the sending number
  at: string;            // callCreated (ISO)
  outcome: string;       // GoTo's callerOutcome as sent ('MISSED', 'NORMAL', 'LEFT_DIAL_PLAN', ...); '' if absent
  raw: unknown;          // the report summary (the full report when it had to be fetched)
  callerName?: string;   // carrier caller ID, whitespace collapsed, cut to 40 chars. Untrusted
  endedAt?: string;
}
```

`on` / `off` accept `'message'` or `'call'`. Registering a `'call'` handler without `watchCalls` logs one warning.

**Call handlers are awaited, one at a time, in registration order** (Python's rule), and the call is saved as seen only
after they have all returned; a handler that throws or rejects is logged by name and the rest still run. This is
deliberately different from Node's message handlers, whose `emit` is synchronous: texts have durable pending rows to
make delivery safe, calls have only this ordering. So a slow call handler holds up the next look and `close()` (which
waits for it), and the contract says so in one line. Do slow work in the background.

## Behaviour to port (Python `sms/inbound/calls.py` is the reference; port it as `src/inbound/calls.ts`)

Same algorithm, same constants, same store keys, so a store written by one package reads correctly in the other:

- Store keys `calls:cursor`, `calls:since`, `calls:seen` (`[[id, ring, atMs], ...]`), `calls:error`.
- Looks every `callPollIntervalMs`, in every incoming mode, only once account and sending number are chosen.
- First look: saves cursor and since as now, asks for the **last minute** (GoTo answers 400 to an empty window), delivers
  nothing. Later looks: from max(cursor − 2 h, now − 24 h) to now, every page (`pageSize` 100, `nextPageMarker` /
  `pageMarker`); if paging is cut short the cursor is not advanced.
- A summary is ours when `direction` is `INBOUND`, `caller.type.value` is `PHONE_NUMBER` and `caller.type.number`
  normalises to the sending number. If `caller.type.number` or `caller.type.value` is missing, the full report decides
  (the `PHONE_NUMBER` participant dialled to the sending number); a failed report fetch leaves the call unseen.
- Never delivered: outbound, another line's calls, calls that started before `calls:since`, and a double ring (the same
  E.164 caller with the same outcome within 120 s of a delivered call). A withheld or non-numeric caller is never a repeat.
- Seen is saved after the handlers return, one call at a time. Seen entries inside the reach-back are never dropped;
  older ones go, oldest first, down to 400.
- Failures: 403, or the login-expired error after a refreshed token got a second 401, is `calls_scope` with the message
  `GoTo refused the call reports. Enable the scope cr.v1.read on the OAuth client, then reconnect.`; then no look for an
  hour, or until the stored token record changes. A really expired login is `login_expired`; other statuses `goto_api`;
  network failure `goto_unreachable`. None of them moves the cursor, marks the login expired, or affects texting. A good
  look clears the error. The scope warning is logged once.

## Contract (`contract/http.md`, `contract/conformance.md`)

Status payload gains, only when call watching is on:

```jsonc
"calls": {
  "watching": true,   // a look has run and the last one worked
  "error": { "error": "calls_scope", "message": "…", "gotoStatus": 403 }   // optional; same shape as incoming.error
}
```

and `requiredScopes` then also lists `cr.v1.read`. (Python today leaves `requiredScopes` alone: change Python to match,
as a commit on pull request #12.)

A new section "Calls" states the behaviour above in contract terms. New conformance rows, each mapped to a Node test
name here and to a Python test name in `aiogotoconnect/docs/conformance.md`:

- **C26** Off by default: no call-report requests, no `calls` key, `cr.v1.read` not in `requiredScopes`.
- **C27** An inbound call to the sending number is delivered once; outbound and other lines' calls never.
- **C28** Nothing that started before watching was switched on is delivered.
- **C29** Double ring: same E.164 caller, same outcome, within 120 s is one event; a different outcome or a withheld
  number is its own event.
- **C30** A refusal sets `calls.error` = `calls_scope`, backs off to hourly until the login changes, never marks the
  login expired, and a good look clears it.
- **C31** Caller number and caller ID never appear in logs at info or above, nor in the status payload.

## The setup page (`setup-ui`)

Only when `status.calls` exists:

- **Manage view:** a "Calls" row under incoming texts.
  - `watching` true: `Watching (801) 555-0100` with the same done mark the other rows use.
  - `error`: the error's `message`, styled as the incoming error is. For `calls_scope` a quiet "Sign in again" button
    sits beside it: it starts the same GoTo sign-in as step 2 (`api/connect`) over the live login, so texting is not
    interrupted, and the new token record ends the hourly back-off at the next look. There is no `login_expired` case
    on this row: with an expired login the page is already showing step 2.
  - neither: `Starting…`.
- **Step 1 (scopes):** `cr.v1.read` appears in the list because the server now sends it; a short note beside it says
  it is for calls.
- Nothing about calls anywhere when `status.calls` is absent. No new control, no new request.

```
Incoming texts   Polling                         ✓
Calls            Watching (801) 555-0100         ✓
```

Works at 320 px and in both themes, like the rest of the page; text built with text nodes, as everywhere.

## Tests

- `test/helpers/fake-goto.ts` learns the two call-report endpoints in the live shape (it rejects an empty or reversed
  window with 400, as GoTo does). `test/calls.test.ts` ports every test in Python's `tests/sms/test_calls.py`.
- Contract tests for the `calls` status key and the conditional scope.
- e2e (Playwright, `examples/express-app` with `watchCalls` behind an env flag): the Calls row shows Watching; with the
  fake refusing, it shows the scope message; without the flag there is no Calls row.

## Order of work

1. This repo, one pull request: contract and conformance, `calls.ts` and the client, the page, tests, README,
   CHANGELOG, version 0.3.0.
2. `aiogotoconnect` pull request #12: `requiredScopes` gains `cr.v1.read` when watching; `docs/conformance.md` gets
   C26-C31.
3. **Taylor:** merge, tag `v0.3.0`, approve the publish.
4. `aiogotoconnect`: `scripts/update-setup-page.sh v0.3.0` (a small follow-up pull request). The to-do board then shows
   the Calls row on its own setup page.

## Calls made here that Taylor has not explicitly decided

- Version 0.3.0 for both the package and the page (a feature, nothing breaking).
- `requiredScopes` grows by `cr.v1.read` only when watching is on, in both packages.
- The Calls row lives on the manage view only, not as a sixth setup step.
- Python's deferred minors are ported unchanged rather than fixed here.
- Call handlers are awaited (unlike message handlers), to keep the at-least-once promise.
- The refused Calls row offers "Sign in again" over the live login. Not verified: whether GoTo hands a newly enabled
  scope to a fresh sign-in without a disconnect first. If it does not, the button's label and the stored message change
  to say disconnect first; check this once against Taylor's own client before release.
- Store keys and formats are identical across the two packages.

## Left to the builder

File-internal names, how the watcher is wired into `client.ts` next to the poller, the exact markup and CSS of the
row within the page's existing tokens, and test helper shapes.
