/**
 * End-to-end local demo — no relays or Lightning required.
 *
 * Spins up a mock toll-booth server, then walks through the full L402 flow:
 *   1. Proxy a request → get a 402 challenge
 *   2. Simulate payment settlement
 *   3. Retry with L402 credential → get the paid response
 *
 * Usage:
 *   npx tsx examples/local-demo.ts
 */
import { createServer } from 'node:http'
import { proxyRequest } from '../src/proxy.js'

// --- Mock toll-booth server ---

const settlements = new Map<string, string>()

const server = createServer((req, res) => {
  // Invoice status endpoint
  if (req.url?.startsWith('/invoice-status/')) {
    const hash = req.url.split('/invoice-status/')[1]?.split('?')[0]
    const preimage = settlements.get(hash ?? '')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(
      preimage ? { settled: true, preimage } : { settled: false },
    ))
    return
  }

  // Authenticated request — return paid data
  if (req.headers.authorization?.startsWith('L402 ')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ result: 'Here is your paid data!', path: req.url }))
    return
  }

  // Unauthenticated — return 402 challenge
  res.writeHead(402, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    l402: {
      bolt11: 'lnbc100n1pdemo...',
      macaroon: 'demo-macaroon-token',
      payment_hash: 'demo-hash-abc',
      amount_sats: 100,
      status_token: 'demo-status-token',
    },
  }))
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const endpoint = `http://127.0.0.1:${port}`
console.log(`Mock toll-booth running on ${endpoint}\n`)

// --- Step 1: Initial request gets a 402 ---

console.log('1. Sending request to /api/data...')
const challenge = await proxyRequest({ endpoint, method: 'GET', path: '/api/data' })

if (challenge.status !== 'payment-required') {
  console.error('Expected 402, got:', challenge.status)
  process.exit(1)
}

console.log(`   Got 402 — invoice: ${challenge.bolt11}`)
console.log(`   Amount: ${challenge.amountSats} sats`)
console.log(`   Payment hash: ${challenge.paymentHash}\n`)

// --- Step 2: Simulate Lightning payment ---

console.log('2. Simulating Lightning payment settlement...')
const preimage = 'demo-preimage-xyz'
settlements.set(challenge.paymentHash, preimage)

// Poll for settlement (as the DVM would)
const pollUrl = `${endpoint}/invoice-status/${challenge.paymentHash}?token=${challenge.statusToken}`
const pollRes = await fetch(pollUrl)
const pollData = await pollRes.json() as { settled: boolean; preimage: string }
console.log(`   Settlement confirmed: ${pollData.settled}`)
console.log(`   Preimage: ${pollData.preimage}\n`)

// --- Step 3: Retry with L402 credential ---

console.log('3. Retrying with L402 credential...')
const result = await proxyRequest({
  endpoint,
  method: 'GET',
  path: '/api/data',
  l402: { macaroon: challenge.macaroon, preimage: pollData.preimage },
})

if (result.status === 'success') {
  console.log(`   Success! Response: ${result.body}\n`)
} else {
  console.error('   Failed:', result)
}

// --- Cleanup ---

server.close()
console.log('Done. This is what toll-booth-dvm does automatically over Nostr.')
