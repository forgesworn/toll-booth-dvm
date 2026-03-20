/**
 * Announce your DVM on Nostr so clients can discover it.
 *
 * Usage:
 *   NOSTR_SK=<64-char-hex> npx tsx examples/announce.ts
 */
import { announce } from '../src/index.js'

const secretKey = process.env.NOSTR_SK
if (!secretKey) {
  console.error('Set NOSTR_SK to a 64-character hex secret key')
  process.exit(1)
}

const result = await announce(
  {
    serviceName: 'My Routing API',
    pricing: {
      '/route': 10,
      '/matrix': { sats: 50, usd: 0.02 },
    },
  },
  {
    secretKey,
    relays: ['wss://relay.damus.io', 'wss://relay.primal.net'],
    urls: ['https://routing.example.com'],
    about: 'Lightning-paid routing — directions and distance matrices',
    topics: ['routing', 'maps', 'lightning'],
  },
)

console.log(`Announced: ${result.eventId}`)
console.log(`Relays: ${result.relays.join(', ')}`)
