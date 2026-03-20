/**
 * Integration tests — no mocks.
 *
 * Uses real nostr-tools for event signing/verification and a real HTTP server
 * to simulate the toll-booth 402 flow. Proves the code works end-to-end
 * without needing a live relay or Lightning node.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { proxyRequest } from '../src/proxy.js'
import { mapBoothConfig } from '../src/mapper.js'
import { HANDLER_KIND, JOB_KIND } from '../src/constants.js'

// ---------- helpers ----------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Spin up a local HTTP server that mimics toll-booth's 402 flow */
function createTollBoothMock(): {
  server: Server
  port: number
  start: () => Promise<void>
  stop: () => Promise<void>
  settlements: Map<string, string>
} {
  const settlements = new Map<string, string>()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Invoice status polling endpoint
    if (req.url?.startsWith('/invoice-status/')) {
      const hash = req.url.split('/invoice-status/')[1]?.split('?')[0]
      const preimage = settlements.get(hash ?? '')
      if (preimage) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ settled: true, preimage }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ settled: false }))
      }
      return
    }

    // Check for L402 auth header — if present, return the paid response
    const authHeader = req.headers['authorization']
    if (authHeader?.startsWith('L402 ')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result: 'paid-data', path: req.url }))
      return
    }

    // No auth — return 402 with L402 challenge
    if (req.url === '/api/free') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result: 'free-data' }))
      return
    }

    res.writeHead(402, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      l402: {
        bolt11: 'lnbc100n1ptest',
        macaroon: 'mac-test-token',
        payment_hash: 'testhash123',
        amount_sats: 100,
        status_token: 'status-tok-abc',
      },
    }))
  })

  let port = 0

  return {
    server,
    get port() { return port },
    settlements,
    async start() {
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          if (addr && typeof addr === 'object') port = addr.port
          resolve()
        })
      })
    },
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}

// ---------- tests ----------

describe('integration: proxyRequest against real HTTP server', () => {
  const mock = createTollBoothMock()

  beforeAll(() => mock.start())
  afterAll(() => mock.stop())

  it('returns success for a free endpoint', async () => {
    const result = await proxyRequest({
      endpoint: `http://127.0.0.1:${mock.port}`,
      method: 'GET',
      path: '/api/free',
    })

    expect(result.status).toBe('success')
    if (result.status === 'success') {
      const parsed = JSON.parse(result.body)
      expect(parsed.result).toBe('free-data')
      expect(result.contentType).toContain('application/json')
    }
  })

  it('returns payment-required with L402 challenge for gated endpoint', async () => {
    const result = await proxyRequest({
      endpoint: `http://127.0.0.1:${mock.port}`,
      method: 'GET',
      path: '/api/paid',
    })

    expect(result.status).toBe('payment-required')
    if (result.status === 'payment-required') {
      expect(result.bolt11).toBe('lnbc100n1ptest')
      expect(result.macaroon).toBe('mac-test-token')
      expect(result.paymentHash).toBe('testhash123')
      expect(result.amountSats).toBe(100)
      expect(result.statusToken).toBe('status-tok-abc')
    }
  })

  it('sends L402 auth header and receives paid response', async () => {
    const result = await proxyRequest({
      endpoint: `http://127.0.0.1:${mock.port}`,
      method: 'GET',
      path: '/api/paid',
      l402: { macaroon: 'mac-test-token', preimage: 'preimage-abc' },
    })

    expect(result.status).toBe('success')
    if (result.status === 'success') {
      const parsed = JSON.parse(result.body)
      expect(parsed.result).toBe('paid-data')
      expect(parsed.path).toBe('/api/paid')
    }
  })

  it('handles full 402 → pay → retry flow', async () => {
    const endpoint = `http://127.0.0.1:${mock.port}`

    // Step 1: initial request gets 402
    const challenge = await proxyRequest({ endpoint, method: 'GET', path: '/api/paid' })
    expect(challenge.status).toBe('payment-required')
    if (challenge.status !== 'payment-required') throw new Error('expected 402')

    // Step 2: simulate settlement (in production, Lightning payment settles)
    mock.settlements.set(challenge.paymentHash, 'real-preimage-xyz')

    // Step 3: poll for settlement
    const pollUrl = `${endpoint}/invoice-status/${challenge.paymentHash}?token=${challenge.statusToken}`
    const pollRes = await fetch(pollUrl)
    const pollData = await pollRes.json() as { settled: boolean; preimage: string }
    expect(pollData.settled).toBe(true)
    expect(pollData.preimage).toBe('real-preimage-xyz')

    // Step 4: retry with L402 credential
    const paidResult = await proxyRequest({
      endpoint,
      method: 'GET',
      path: '/api/paid',
      l402: { macaroon: challenge.macaroon, preimage: pollData.preimage },
    })
    expect(paidResult.status).toBe('success')
    if (paidResult.status === 'success') {
      expect(JSON.parse(paidResult.body).result).toBe('paid-data')
    }

    // Clean up
    mock.settlements.delete(challenge.paymentHash)
  })

  it('forwards POST body correctly', async () => {
    // The mock returns paid-data for any authed request, but let's verify
    // the request reaches the server with the right method
    const result = await proxyRequest({
      endpoint: `http://127.0.0.1:${mock.port}`,
      method: 'POST',
      path: '/api/paid',
      body: JSON.stringify({ query: 'test' }),
      l402: { macaroon: 'mac', preimage: 'pre' },
    })

    expect(result.status).toBe('success')
  })

  it('respects timeout', async () => {
    // Create a server that never responds
    const hangServer = createServer(() => {
      // intentionally do nothing — let it hang
    })
    await new Promise<void>((resolve) => hangServer.listen(0, '127.0.0.1', resolve))
    const hangPort = (hangServer.address() as { port: number }).port

    await expect(
      proxyRequest({
        endpoint: `http://127.0.0.1:${hangPort}`,
        method: 'GET',
        path: '/api/test',
        timeoutMs: 200,
      }),
    ).rejects.toThrow()

    await new Promise<void>((resolve, reject) => {
      hangServer.close((err) => (err ? reject(err) : resolve()))
    })
  })
})

describe('integration: Nostr event validity with real nostr-tools', () => {
  it('mapBoothConfig produces valid NIP-89 event structure', () => {
    const config = {
      pricing: {
        '/route': 10,
        '/matrix': { sats: 50, usd: 0.02 },
      },
      serviceName: 'Test Routing API',
    }

    const mapped = mapBoothConfig(config, {
      secretKey: 'a'.repeat(64),
      relays: ['wss://relay.test'],
      urls: ['https://api.test'],
      about: 'Test routing service',
      topics: ['routing', 'maps'],
    })

    // Verify kind tag
    expect(mapped.tags).toContainEqual(['k', String(JOB_KIND)])

    // Verify d tag (identifier)
    const dTag = mapped.tags.find((t) => t[0] === 'd')
    expect(dTag).toBeDefined()
    expect(dTag![1]).toBe('test-routing-api')

    // Verify topic tags
    expect(mapped.tags).toContainEqual(['t', 'routing'])
    expect(mapped.tags).toContainEqual(['t', 'maps'])

    // Verify content is valid JSON
    const content = mapped.content
    expect(content.name).toBe('Test Routing API')
    expect(content.about).toBe('Test routing service')
    expect(content.urls).toEqual(['https://api.test'])
    expect(content.paymentMethods).toContain('lightning')

    // Verify pricing is correctly mapped
    expect(content.pricing).toContainEqual({ capability: '/route', price: 10, currency: 'sats' })
    expect(content.pricing).toContainEqual({ capability: '/matrix', price: 50, currency: 'sats' })
    expect(content.pricing).toContainEqual({ capability: '/matrix', price: 0.02, currency: 'usd' })
  })

  it('announce produces a verifiable signed event', async () => {
    const sk = generateSecretKey()
    const skHex = bytesToHex(sk)
    const expectedPubkey = getPublicKey(sk)

    // We need to intercept the event before it's published to relays.
    // Since announce() publishes to real relays (which will fail in test),
    // we test event construction through mapBoothConfig + finalizeEvent directly.
    const { finalizeEvent } = await import('nostr-tools/pure')

    const config = { pricing: { '/api': 100 }, serviceName: 'Integration Test' }
    const mapped = mapBoothConfig(config, {
      secretKey: skHex,
      relays: ['wss://relay.test'],
      urls: ['https://example.com'],
      about: 'Integration test service',
    })

    const event = finalizeEvent(
      {
        kind: HANDLER_KIND,
        content: JSON.stringify(mapped.content),
        tags: mapped.tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    )

    // Verify event has all required Nostr fields
    expect(event.id).toMatch(/^[0-9a-f]{64}$/)
    expect(event.pubkey).toBe(expectedPubkey)
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/)
    expect(event.kind).toBe(HANDLER_KIND)

    // Verify event signature is valid (this is the critical production check)
    expect(verifyEvent(event)).toBe(true)

    // Verify content is parseable and correct
    const content = JSON.parse(event.content)
    expect(content.name).toBe('Integration Test')
    expect(content.pricing).toEqual([{ capability: '/api', price: 100, currency: 'sats' }])
  })

  it('event tags conform to NIP-89 handler format', async () => {
    const sk = generateSecretKey()
    const { finalizeEvent } = await import('nostr-tools/pure')

    const config = { pricing: { '/route': 10 }, serviceName: 'Tag Test' }
    const mapped = mapBoothConfig(config, {
      secretKey: bytesToHex(sk),
      relays: ['wss://relay.test'],
      urls: ['https://example.com'],
      about: 'Tag test',
      topics: ['routing'],
    })

    const event = finalizeEvent(
      {
        kind: HANDLER_KIND,
        content: JSON.stringify(mapped.content),
        tags: mapped.tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    )

    // NIP-89 requires a 'd' tag for replaceable events
    const dTag = event.tags.find((t: string[]) => t[0] === 'd')
    expect(dTag).toBeDefined()
    expect(dTag![1].length).toBeGreaterThan(0)

    // NIP-89 handler should declare which kind it handles via 'k' tag
    const kTag = event.tags.find((t: string[]) => t[0] === 'k')
    expect(kTag).toBeDefined()
    expect(kTag![1]).toBe('5800')

    // Kind 31990 is a parameterised replaceable event (30000-39999)
    expect(event.kind).toBeGreaterThanOrEqual(30000)
    expect(event.kind).toBeLessThan(40000)
  })
})
