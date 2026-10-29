# Security policy

`@oneofthegeeks/goto-sms` handles OAuth credentials, refresh tokens and phone numbers, so
security reports are taken seriously. Unofficial package; not affiliated with or endorsed by GoTo.

## Supported versions

| Version | Supported                     |
| ------- | ----------------------------- |
| 0.2.x   | Yes                           |
| 0.1.x   | Critical fixes only (Node 20) |
| < 0.1   | No                            |

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub:
[Security → Report a vulnerability](https://github.com/oneofthegeeks/goto-sms/security/advisories/new).

Include what you found, how to reproduce it, the affected version, and the impact you expect.
Don't include real GoTo credentials, tokens, phone numbers or message text.

What to expect:

- an acknowledgement within 3 business days;
- an assessment and a fix plan within 10 business days;
- a patched release published to npm (with provenance) and a GitHub security advisory crediting
  you, unless you'd rather stay anonymous.

## In scope

- Leaking the client secret, access or refresh tokens, the webhook secret or message bodies (in
  API responses, logs at `info` level or above, or the setup page).
- Bypassing `authorize` on the setup page or API, the OAuth `state` check, or the webhook path
  secret.
- Cross-site scripting or open redirects in the setup page (`backUrl`, `loginUrl`).
- Inbound texts acting on the wrong app (texts addressed to another number in the GoTo account).
- Weak handling of secrets at rest (the encryption key, the key file, the stores).

## Out of scope

- Vulnerabilities in GoTo Connect itself. Report those to GoTo.
- A host app that passes an `authorize` function that allows everyone, or runs with
  `allowUnauthenticatedSetup` in production.
- Denial of service through volume alone.
