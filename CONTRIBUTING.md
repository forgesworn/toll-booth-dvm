# Contributing to toll-booth-dvm

## Setup

```bash
git clone https://github.com/forgesworn/toll-booth-dvm.git
cd toll-booth-dvm
npm ci
npm run build
npm test
```

Requires Node.js 22+.

## Development

```bash
npm run test:watch   # vitest in watch mode
npm run build        # tsc → build/
npm test             # vitest run (single pass)
```

## Project structure

```
src/
  index.ts       — public exports
  announce.ts    — publish NIP-89 kind 31990 handler event
  serve.ts       — relay loop (subscribe → proxy → publish)
  proxy.ts       — HTTP proxy with path validation and L402 retry
  mapper.ts      — booth config → NIP-89 event mapping
  slugify.ts     — deterministic identifier from service name
  constants.ts   — Nostr event kind constants
  types.ts       — public TypeScript interfaces
  utils.ts       — hex conversion, key validation
tests/
  *.test.ts      — unit tests (vitest)
```

## Code conventions

- **British English** — colour, initialise, behaviour, licence
- **Commit messages** — `type: description` (e.g. `feat:`, `fix:`, `docs:`)
- **Single runtime dependency** — only `nostr-tools`. Keep the dependency footprint minimal.
- **Secret key handling** — always zeroise after use (`sk.fill(0)`)

## Pull requests

1. Branch from `main`
2. Keep changes focused — one feature or fix per PR
3. Ensure `npm run build && npm test` passes
4. Semantic-release handles versioning — do not manually bump `package.json`

## Reporting issues

Open an issue at [github.com/forgesworn/toll-booth-dvm/issues](https://github.com/forgesworn/toll-booth-dvm/issues).
