Unofficial. Not affiliated with or endorsed by GoTo.

# goto-sms

Send and receive GoTo Connect SMS from your app without learning GoTo's OAuth quirks. You install
the package, open a built-in setup page, paste your own GoTo OAuth client ID and secret, click
Connect, pick an account and a sending number, and send a test text. Incoming texts and
STOP/START/HELP handling are built in.

```sh
npm install @oneofthegeeks/goto-sms express
```

The Node package is `@oneofthegeeks/goto-sms` on npm. See
[`packages/node/README.md`](packages/node/README.md) for the quick start, configuration, incoming
texts, storage and troubleshooting.

## Repo layout

| Path                      | What                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/node/`          | The Node/TypeScript package.                                                                  |
| `setup-ui/`               | The shared static setup page, built once and embedded into each language package.             |
| `contract/http.md`        | The language-neutral HTTP contract the setup page calls.                                      |
| `contract/conformance.md` | The 23 required behaviours (C1-C23), each mapped to its Node test.                            |
| `examples/express-app/`   | A runnable Express demo with a Dockerfile (it logs inbound message bodies; it is an example). |
| `e2e/`                    | Playwright browser test of the setup page against a fake GoTo.                                |
| `docs/superpowers/specs/` | The design spec.                                                                              |

Other languages reuse the setup page, the HTTP contract and the conformance checklist.
Python: [aiogotoconnect](https://github.com/oneofthegeeks/aiogotoconnect) (`pip install aiogotoconnect[sms]`).

## Develop

```sh
npm install
npm run typecheck && npm run lint && npm run build && npm test
npm run e2e   # Playwright (run `npx playwright install chromium` once)
```

## License

MIT

## Security and contributing

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
