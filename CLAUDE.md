# CLAUDE.md — toll-booth-dvm

## What this is

TypeScript library that bridges toll-booth-gated HTTP APIs to Nostr as NIP-90 Data Vending Machines. Two main exports: `announce` (publish NIP-89 discovery event) and `serve` (relay loop handling L402 payment flow).

## Build & test

```bash
npm ci
npm run build    # tsc → build/
npm test         # vitest run
```

## Architecture

```
src/
  index.ts       — public exports (announce, serve, types, constants)
  announce.ts    — publish kind 31990 NIP-89 handler event
  serve.ts       — relay loop: subscribe to kind 5800, proxy, handle L402, publish kind 6800
  proxy.ts       — HTTP proxy with path validation and L402 retry
  mapper.ts      — convert BoothConfigLike → NIP-89 event tags/content
  slugify.ts     — deterministic identifier from service name
  constants.ts   — Nostr event kind constants (5800, 6800, 7000, 31990)
  types.ts       — public TypeScript interfaces
  utils.ts       — hex conversion, secret key validation
```

## Conventions

- British English (colour, initialise, behaviour, licence)
- Commit messages: `type: description` (feat:, fix:, docs:, refactor:)
- Amounts in satoshis (smallest unit)
- No Co-Authored-By lines in commits
- Single runtime dependency (nostr-tools). Keep it minimal.

## Key implementation details

- Secret keys are zeroised after use (`sk.fill(0)`)
- Deduplication via in-memory seen map with 10-minute TTL
- Path traversal prevention (rejects `..` and `//`)
- Non-custodial: bolt11 strings are relayed, never stored beyond the request lifecycle
- L402 credential format: `L402 {macaroon}:{preimage}`

## Release

Semantic-release on push to main. Do not manually bump versions.
