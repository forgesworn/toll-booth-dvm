# AGENTS.md — toll-booth-dvm

See [CLAUDE.md](CLAUDE.md) for full agent instructions including architecture, build/test commands, conventions, and implementation details.

## Quick reference

```bash
npm ci && npm run build && npm test
```

- TypeScript, strict mode, ESM
- Single runtime dependency: `nostr-tools`
- British English spelling
- Commit format: `type: description`
- Secret keys must be zeroised after use
