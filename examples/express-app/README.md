# goto-sms example (Express)

A small host app: the goto-sms setup page at `/goto-sms/` behind HTTP Basic auth, `POST /send`,
inbound texts logged to stdout, and `GET /healthz` for the container healthcheck.

## Run it

```sh
export ADMIN_PASSWORD=choose-one
export GOTO_SMS_PUBLIC_URL=https://sms.example.com   # the redirect URI is this + /goto-sms/callback
node server.mjs
```

Open `/goto-sms/` (any username, the password above) and follow the page. Data (encrypted
tokens, message log) lives in `GOTO_SMS_DATA_DIR` (default `./data`), including a generated
encryption key unless you set `GOTO_SMS_ENCRYPTION_KEY`. Run one process per data directory.

Send a text once connected:

```sh
curl -u :$ADMIN_PASSWORD -H 'Content-Type: application/json' \
  -d '{"to":"+18015550199","text":"hello"}' http://localhost:3000/send
```

In this monorepo the dependency is a workspace link to the built package, so run
`npm run build` at the repo root first. The Playwright test in `/e2e` drives this app against a
fake GoTo (`GOTO_SMS_AUTH_BASE_URL` / `GOTO_SMS_API_BASE_URL` point the package at it).

## Docker

The Dockerfile installs the published package from npm, so it builds once
`@oneofthegeeks/goto-sms` is published:

```sh
docker build -t goto-sms-example examples/express-app
docker run -p 3000:3000 -v goto-sms-data:/data -e ADMIN_PASSWORD=... goto-sms-example
```
