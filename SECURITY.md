# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in toll-booth-dvm, please report it responsibly.

**Email:** security@forgesworn.dev

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Scope

toll-booth-dvm is non-custodial middleware — it relays Lightning invoices and L402 credentials but never holds or forwards funds. Security concerns include:

- **Input validation** — path traversal, method injection, malformed Nostr events
- **Secret key handling** — zeroisation of signing key bytes after use
- **Upstream response handling** — defensive parsing of L402 challenge data
- **Denial of service** — deduplication map bounds, event age validation

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
