# goto-sms

Live: not yet published

## What This Is

`@oneofthegeeks/goto-sms`: an unofficial Node/TypeScript npm package for sending and receiving GoTo Connect SMS. Design: `docs/superpowers/specs/2026-10-27-goto-sms-design.md`.

## Stack

TypeScript (strict, NodeNext), tsup (ESM+CJS+dts), tsx for tests, oxlint (type-aware) + prettier. npm workspaces (currently `packages/node` only).

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

## Gotchas

- Imports use `.js` extensions (NodeNext); tsx resolves them to `.ts`.
- `VERSION` is `'dev'` under tsx, the package.json version in built output.
- Lint needs `oxlint-tsgolint` alongside `oxlint`.
