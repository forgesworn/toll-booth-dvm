# toll-booth-dvm

**Nostr:** [`npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`](https://njump.me/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2)

Expose any [toll-booth](https://github.com/forgesworn/toll-booth)-gated HTTP API as a [NIP-90](https://github.com/nostr-protocol/nips/blob/master/90.md) Data Vending Machine on Nostr.

Clients send kind 5800 job requests over Nostr. The DVM proxies them to your toll-booth endpoint, relays the Lightning invoice, and publishes the result as kind 6800 — without ever holding funds.

## Install

```bash
npm install toll-booth-dvm
```

## Announce

Publish a NIP-89 kind 31990 handler event so clients can discover your DVM:

```typescript
import { announce } from 'toll-booth-dvm'

const announcement = await announce(
  {
    serviceName: 'My Routing API',
    pricing: {
      '/route': 10,
      '/matrix': { sats: 50, usd: 0.02 },
    },
  },
  {
    secretKey: process.env.NOSTR_SK,
    relays: ['wss://relay.damus.io', 'wss://relay.primal.net'],
    urls: ['https://routing.example.com'],
    about: 'Lightning-paid routing API — turn-by-turn directions and matrix queries',
    topics: ['routing', 'maps', 'bitcoin', 'lightning'],
  },
)

console.log(`Announced: event ${announcement.eventId}`)
```

## Serve

Start the relay loop — listens for kind 5800 jobs and proxies them to your endpoint:

```typescript
import { serve } from 'toll-booth-dvm'

const dvm = await serve({
  secretKey: process.env.NOSTR_SK,
  relays: ['wss://relay.damus.io', 'wss://relay.primal.net'],
  endpoint: 'http://localhost:3000',   // your toll-booth endpoint
  announceOnStart: true,               // publish kind 31990 on startup
  boothConfig: {
    serviceName: 'My Routing API',
    pricing: { '/route': 10 },
  },
  about: 'Lightning-paid routing API',
  allowedPaths: ['/route', '/matrix'], // optional path whitelist
})

// Graceful shutdown
process.on('SIGINT', () => dvm.close())
```

### Serve options

| Option | Default | Description |
|--------|---------|-------------|
| `secretKey` | required | Hex-encoded Nostr secret key |
| `relays` | required | Relay URLs to subscribe on |
| `endpoint` | required | Upstream toll-booth base URL |
| `announceOnStart` | `false` | Publish kind 31990 on startup |
| `boothConfig` | — | Required if `announceOnStart` is true |
| `about` | — | Service description for announcements |
| `allowedPaths` | — | Whitelist of permitted request paths |
| `pollIntervalMs` | `2000` | Payment settlement poll interval |
| `maxPendingJobs` | `10` | Max concurrent in-flight jobs |
| `requestTimeoutMs` | `30000` | Upstream HTTP request timeout |
| `paymentTimeoutMs` | `300000` | Time to wait for Lightning settlement |
| `maxBodyBytes` | `65536` | Max request body size |

## Job request format

Clients send kind 5800 events with `param` tags describing the HTTP request:

```json
{
  "kind": 5800,
  "tags": [
    ["p", "<dvm-pubkey>"],
    ["param", "method", "GET"],
    ["param", "path", "/route"],
    ["param", "accept", "application/json"],
    ["bid", "15000"]
  ],
  "content": ""
}
```

| Tag | Values | Description |
|-----|--------|-------------|
| `param method` | `GET`, `POST`, etc. | HTTP method (default: `GET`) |
| `param path` | `/route` | Path on the upstream endpoint |
| `param body` | JSON string | Request body for POST/PUT |
| `param accept` | MIME type | Forwarded as `Accept` header |
| `bid` | millisats | Optional max price — job is rejected if price exceeds bid |

Results are published as kind 6800 with the response body in `content`. Errors and payment requests arrive as kind 7000 feedback events.

## How it works

1. Client publishes a kind 5800 job request tagged with the DVM's pubkey.
2. DVM proxies the request to the toll-booth endpoint.
3. If the endpoint returns **HTTP 402**, the DVM publishes a kind 7000 feedback event with `status: payment-required` and an `amount` tag containing the bolt11 invoice.
4. The client pays the Lightning invoice out-of-band.
5. The DVM polls the endpoint's `/invoice-status/{hash}` route until settlement is confirmed.
6. Once settled, the DVM retries the original request with the L402 `Authorization` header and publishes the response as kind 6800.

The DVM never holds the bolt11 string for longer than needed — it is relayed directly from the upstream endpoint to the Nostr event and then discarded.

## Operator responsibilities

**Non-custodial middleware.** toll-booth-dvm never holds or forwards funds. Lightning payments are settled directly between the client's wallet and your toll-booth backend. The DVM only relays bolt11 strings and preimages.

**Geo-fencing.** If your service is restricted in certain jurisdictions, enforce those restrictions at the toll-booth layer using its `blockedCountries` option. The DVM has no visibility into client geography.

**Tor / Handshake endpoints.** Running a DVM as a bridge to a `.onion` or Handshake domain gives clients on the clearnet access to otherwise-unreachable services. This is legally analogous to operating a Tor exit node — permissibility is jurisdiction-dependent. Understand the laws in your jurisdiction before deploying.

**No persistent client data.** The DVM does not log or store client pubkeys, job contents, or payment data beyond the in-memory deduplication window (10 minutes). No data is persisted to disk.

**Input validation.** All client-supplied paths are percent-decoded and validated against traversal attacks before forwarding. HTTP methods are restricted to GET/POST/PUT/PATCH/DELETE. Events older than 10 minutes are rejected. Payment hashes are validated as 64-character hex strings.

## Examples

See [`examples/`](examples/) for runnable scripts:

- **`local-demo.ts`** — full L402 flow with a mock server, zero setup: `npx tsx examples/local-demo.ts`
- **`announce.ts`** — publish a NIP-89 discovery event
- **`serve.ts`** — start the relay loop

## Licence

MIT

---

**Related packages**

- [toll-booth](https://github.com/forgesworn/toll-booth) — L402 middleware that gates any HTTP API behind Lightning
- [toll-booth-announce](https://github.com/forgesworn/toll-booth-announce) — publish your toll-booth service as a kind 31402 Nostr discovery event
