# goto-sms

Live: not yet published

## What This Is

`@oneofthegeeks/goto-sms`: an unofficial Node/TypeScript npm package for sending and receiving GoTo Connect SMS. Design: `docs/superpowers/specs/2026-10-27-goto-sms-design.md`.

## Stack

TypeScript (strict, NodeNext), tsup (ESM+CJS+dts), tsx for tests, oxlint (type-aware) + prettier. npm workspaces: `setup-ui` (plain-TS setup page, esbuild-inlined to one HTML file) and `packages/node`. express is a peer dep (loaded lazily).

## Local Development

```sh
npm install
npm run typecheck && npm run lint && npm test && npm run build
```

## Testing

- Unit/contract suites: `npm test` (`node:test` via `tsx --test` in `packages/node/test`; builds setup-ui first). They run against an in-process fake GoTo (`test/helpers/fake-goto.ts`); nothing touches real GoTo.
- Browser e2e: `npm run e2e` (= `npx playwright test`) drives `examples/express-app` against the fake GoTo.
- C1-C23 map to test names in `contract/conformance.md`; keep it in sync when renaming tests.

## Deployment

Library: tag `vX.Y.Z` -> publish.yml -> npm (manual approval). No Docker/Poppy.

## Key Files

- `packages/node/src/client.ts` - `createGoToSms` facade and options
- `packages/node/src/server/express.ts` - Express router; `handlers.ts` - framework-free `(req, res)` handlers for `contract/http.md`
- `packages/node/src/types.ts` - shared types, `VERSION`; `errors.ts` - error classes; `index.ts` - public exports
- `packages/node/scripts/embed-setup.mjs` - embeds `setup-ui/dist` into the generated (gitignored) `setup-html.generated.ts`
- `packages/node/tsup.config.ts` - build; injects `__VERSION__`
- `setup-ui/` - the shared static setup page
- `contract/` - `http.md` (endpoint spec), `conformance.md` (C1-C23 to tests)
- `e2e/` - Playwright test; `examples/express-app/` - runnable demo
- `.github/workflows/` - `ci.yml`, `publish.yml` (tag `v*`, `npm` environment)

## Gotchas

- Imports use `.js` extensions (NodeNext); tsx resolves them to `.ts`.
- `VERSION` is `'dev'` under tsx, the package.json version in built output.
- Lint needs `oxlint-tsgolint` alongside `oxlint`.
- `src/server/setup-html.generated.ts` is gitignored, written by `scripts/embed-setup.mjs` (pre
  typecheck/test/build): the real page if `setup-ui/dist` exists, else a stub. Run `npm run build`
  after changing setup-ui.
- The setup page must use relative URLs only (`api/status`); a test enforces it.
- Publish and `npm run build` must run from the repo root: it builds setup-ui before packages/node, otherwise the package embeds a stub page.
- `prelint`/`typecheck` run the embed step, so a fresh clone lints without a prior build.
- Package `LICENSE` is a copy of the root one (npm ships it from `packages/node`).
