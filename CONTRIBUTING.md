# Contributing

Thanks for helping. This is a small, unofficial package, so issues and focused pull requests are
welcome. For security problems, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setup

```sh
npm install
npm run typecheck && npm run lint && npm test && npm run build
npx playwright test   # browser smoke test against the fake GoTo
```

Requires Node 22 or newer. Tests never call the real GoTo: they run against an in-process fake
(`packages/node/test/helpers/fake-goto.ts`).

## Pull requests

- Keep each PR to one change, with a test that fails without it.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`fix(node): …`, `feat: …`).
- CI must pass on Node 22 and 24, plus the e2e job. PRs are squash-merged.
- If you change the HTTP API or the setup page's behaviour, update `contract/http.md` too. Other
  language ports share that contract.
- Never put real credentials, tokens, phone numbers or message text in code, tests, issues or logs.

## Releases

Maintainers release by bumping `packages/node/package.json`, adding a `CHANGELOG.md` row and pushing
a `vX.Y.Z` tag. The publish workflow waits for approval, then publishes to npm through trusted
publishing, with provenance.
