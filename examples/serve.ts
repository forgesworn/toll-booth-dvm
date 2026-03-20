/**
 * Start a DVM that proxies requests to a toll-booth endpoint.
 *
 * Usage:
 *   NOSTR_SK=<64-char-hex> ENDPOINT=http://localhost:3000 npx tsx examples/serve.ts
 */
import { serve } from '../src/index.js'

const secretKey = process.env.NOSTR_SK
const endpoint = process.env.ENDPOINT ?? 'http://localhost:3000'

if (!secretKey) {
  console.error('Set NOSTR_SK to a 64-character hex secret key')
  process.exit(1)
}

const dvm = await serve({
  secretKey,
  relays: ['wss://relay.damus.io', 'wss://relay.primal.net'],
  endpoint,
  announceOnStart: true,
  boothConfig: {
    serviceName: 'My Routing API',
    pricing: { '/route': 10 },
  },
  about: 'Lightning-paid routing API',
  allowedPaths: ['/route', '/matrix'],
})

console.log(`DVM listening on ${endpoint}`)
console.log('Press Ctrl+C to stop')

process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  await dvm.close()
  process.exit(0)
})
