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

`node:test` via `tsx --test` in `packages/node/test`, one file per module, against an in-process fake GoTo (`test/helpers/fake-goto.ts`). No test touches the real GoTo.

## Deployment

Library: tag `vX.Y.Z` -> publish.yml -> npm (manual approval). No Docker/Poppy.

## Key Files

- `packages/node/src/types.ts` - shared types, `VERSION`
- `packages/node/src/errors.ts` - error classes
- `packages/node/src/index.ts` - public exports
- `packages/node/src/client.ts` - `createGoToSms` facade and the internal `Core`
- `packages/node/src/server/handlers.ts` - framework-free setup/API/callback/webhook handlers; `status.ts` builds the status payload
- `contract/http.md` - language-neutral HTTP contract (keep in sync with handlers.ts)
- `packages/node/tsup.config.ts` - build; injects `__VERSION__`
- `packages/node/src/server/handlers.ts` - framework-free routes (`contract/http.md` documents them)
- `packages/node/src/server/express.ts` - Express adapter behind `sms.router()` / `webhookRouter()`
- `setup-ui/src/` - setup page (`index.html`, `app.ts`, `styles.css`); `build.mjs` inlines them

## Gotchas

- Imports use `.js` extensions (NodeNext); tsx resolves them to `.ts`.
- `VERSION` is `'dev'` under tsx, the package.json version in built output.
- Lint needs `oxlint-tsgolint` alongside `oxlint`.
- `src/server/setup-html.generated.ts` is gitignored, written by `scripts/embed-setup.mjs` (pre
  typecheck/test/build): the real page if `setup-ui/dist` exists, else a stub. Run `npm run build`
  after changing setup-ui.
- The setup page must use relative URLs only (`api/status`); a test enforces it.
