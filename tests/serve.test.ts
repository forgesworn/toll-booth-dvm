import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Hoisted mocks (accessible inside vi.mock factories) ---

const {
  mockPublish,
  mockSubClose,
  mockProxyRequest,
  mockValidatePath,
  mockValidateMethod,
  mockAnnounce,
  subscribeManyState,
} = vi.hoisted(() => ({
  mockPublish: vi.fn().mockReturnValue([Promise.resolve('ok')]),
  mockSubClose: vi.fn(),
  mockProxyRequest: vi.fn(),
  mockValidatePath: vi.fn(),
  mockValidateMethod: vi.fn(),
  mockAnnounce: vi.fn().mockResolvedValue({ eventId: 'ann-id', relays: ['wss://r.test'] }),
  subscribeManyState: { callback: undefined as ((event: unknown) => void) | undefined },
}))

vi.mock('nostr-tools/pool', () => {
  const SimplePool = vi.fn(function (this: object) {
    Object.assign(this, {
      publish: mockPublish,
      close: vi.fn(),
      subscribeMany: vi.fn((_relays: string[], _filters: unknown[], opts: { onevent: (e: unknown) => void }) => {
        subscribeManyState.callback = opts.onevent
        return { close: mockSubClose }
      }),
    })
  })
  return { SimplePool }
})

vi.mock('nostr-tools/pure', () => ({
  finalizeEvent: vi.fn((template: Record<string, unknown>) => ({
    ...template,
    id: 'finalized-id',
    pubkey: 'dvm-pubkey',
    sig: 'sig123',
  })),
  getPublicKey: vi.fn(() => 'dvm-pubkey'),
}))

vi.mock('../src/proxy.js', () => ({
  proxyRequest: mockProxyRequest,
  validatePath: mockValidatePath,
  validateMethod: mockValidateMethod,
}))

vi.mock('../src/announce.js', () => ({
  announce: mockAnnounce,
}))

import { serve } from '../src/serve.js'
import { SimplePool } from 'nostr-tools/pool'
import { JOB_KIND, FEEDBACK_KIND, RESULT_KIND } from '../src/constants.js'

const SECRET_KEY = 'a'.repeat(64)

function makeJobEvent(overrides: Partial<{
  id: string; pubkey: string; tags: string[][]; content: string
}> = {}) {
  return {
    id: overrides.id ?? 'job-1',
    pubkey: overrides.pubkey ?? 'requester-pubkey',
    kind: JOB_KIND,
    content: overrides.content ?? '',
    tags: overrides.tags ?? [
      ['p', 'dvm-pubkey'],
      ['param', 'method', 'GET'],
      ['param', 'path', '/api/test'],
    ],
    created_at: Math.floor(Date.now() / 1000),
    sig: 'sig-job',
  }
}

describe('serve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    subscribeManyState.callback = undefined
    mockProxyRequest.mockReset()
    mockValidatePath.mockReset()
    mockAnnounce.mockReset().mockResolvedValue({ eventId: 'ann-id', relays: ['wss://r.test'] })
  })

  afterEach(async () => {
    // Clean up any lingering timers
  })

  it('validates secretKey', async () => {
    await expect(
      serve({ secretKey: 'bad', relays: ['wss://r.test'], endpoint: 'https://e.test' }),
    ).rejects.toThrow('secretKey must be 64 hex characters')
  })

  it('subscribes to kind 5800 filtered by #p with DVM pubkey', async () => {
    const handle = await serve({ secretKey: SECRET_KEY, relays: ['wss://r.test'], endpoint: 'https://e.test' })

    const pool = vi.mocked(SimplePool).mock.instances[0] as unknown as { subscribeMany: ReturnType<typeof vi.fn> }
    expect(pool.subscribeMany).toHaveBeenCalledWith(
      ['wss://r.test'],
      { kinds: [JOB_KIND], '#p': ['dvm-pubkey'] },
      expect.objectContaining({ onevent: expect.any(Function) }),
    )

    await handle.close()
  })

  it('deduplicates events by ID', async () => {
    mockProxyRequest.mockResolvedValue({ status: 'success', body: '{"ok":true}', contentType: 'application/json' })

    const handle = await serve({ secretKey: SECRET_KEY, relays: ['wss://r.test'], endpoint: 'https://e.test' })
    const event = makeJobEvent()

    subscribeManyState.callback!(event)
    subscribeManyState.callback!(event) // duplicate

    // Allow async handleJob to settle
    await new Promise((r) => setTimeout(r, 50))

    // proxyRequest should only have been called once
    expect(mockProxyRequest).toHaveBeenCalledTimes(1)

    await handle.close()
  })

  it('publishes kind 6800 result on successful proxy', async () => {
    mockProxyRequest.mockResolvedValue({ status: 'success', body: '{"data":"ok"}', contentType: 'application/json' })

    const handle = await serve({ secretKey: SECRET_KEY, relays: ['wss://r.test'], endpoint: 'https://e.test' })
    subscribeManyState.callback!(makeJobEvent())

    await new Promise((r) => setTimeout(r, 50))

    const resultCall = mockPublish.mock.calls.find(
      (call) => (call[1] as { kind: number }).kind === RESULT_KIND,
    )
    expect(resultCall).toBeDefined()
    expect((resultCall![1] as { content: string }).content).toBe('{"data":"ok"}')

    await handle.close()
  })

  it('publishes kind 7000 payment-required feedback on 402', async () => {
    mockProxyRequest.mockResolvedValueOnce({
      status: 'payment-required',
      bolt11: 'lnbc10n1...',
      macaroon: 'mac123',
      paymentHash: 'a'.repeat(64),
      amountSats: 500,
      statusToken: 'tok123',
    })

    // Mock fetch for polling — never settles so it times out
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ settled: false }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const handle = await serve({
      secretKey: SECRET_KEY,
      relays: ['wss://r.test'],
      endpoint: 'https://e.test',
      paymentTimeoutMs: 50,
      pollIntervalMs: 10,
    })
    subscribeManyState.callback!(makeJobEvent())

    await new Promise((r) => setTimeout(r, 200))

    const paymentCall = mockPublish.mock.calls.find(
      (call) => {
        const evt = call[1] as { kind: number; tags: string[][] }
        return evt.kind === FEEDBACK_KIND &&
          evt.tags.some((t: string[]) => t[0] === 'status' && t[1] === 'payment-required')
      },
    )
    expect(paymentCall).toBeDefined()
    // Check amount tag: 500 sats = 500000 millisats
    const amountTag = (paymentCall![1] as { tags: string[][] }).tags.find(
      (t: string[]) => t[0] === 'amount',
    )
    expect(amountTag).toEqual(['amount', '500000', 'lnbc10n1...'])

    vi.unstubAllGlobals()
    await handle.close()
  })

  it('respects maxPendingJobs', async () => {
    // Make proxyRequest hang until we resolve
    let resolvers: (() => void)[] = []
    mockProxyRequest.mockImplementation(
      () => new Promise<{ status: string; body: string; contentType: string }>((resolve) => {
        resolvers.push(() => resolve({ status: 'success', body: 'ok', contentType: 'text/plain' }))
      }),
    )

    const handle = await serve({
      secretKey: SECRET_KEY,
      relays: ['wss://r.test'],
      endpoint: 'https://e.test',
      maxPendingJobs: 2,
    })

    // Send 3 jobs — only 2 should be accepted
    subscribeManyState.callback!(makeJobEvent({ id: 'job-a' }))
    subscribeManyState.callback!(makeJobEvent({ id: 'job-b' }))
    subscribeManyState.callback!(makeJobEvent({ id: 'job-c' }))

    await new Promise((r) => setTimeout(r, 50))

    // Only 2 proxy calls
    expect(mockProxyRequest).toHaveBeenCalledTimes(2)

    // Resolve pending jobs
    resolvers.forEach((r) => r())
    await new Promise((r) => setTimeout(r, 50))

    await handle.close()
  })

  it('calls announce on start when announceOnStart is true', async () => {
    const boothConfig = { pricing: { '/api/route': 1000 }, serviceName: 'Test' }

    const handle = await serve({
      secretKey: SECRET_KEY,
      relays: ['wss://r.test'],
      endpoint: 'https://e.test',
      announceOnStart: true,
      boothConfig,
      about: 'My DVM',
    })

    expect(mockAnnounce).toHaveBeenCalledWith(boothConfig, {
      secretKey: SECRET_KEY,
      relays: ['wss://r.test'],
      urls: ['https://e.test'],
      about: 'My DVM',
    })

    await handle.close()
  })

  it('rejects job when bid is below price (price-exceeds-bid)', async () => {
    mockProxyRequest.mockResolvedValueOnce({
      status: 'payment-required',
      bolt11: 'lnbc...',
      macaroon: 'mac',
      paymentHash: 'b'.repeat(64),
      amountSats: 1000,
      statusToken: 'tok',
    })

    const handle = await serve({
      secretKey: SECRET_KEY,
      relays: ['wss://r.test'],
      endpoint: 'https://e.test',
    })

    const event = makeJobEvent({
      tags: [
        ['p', 'dvm-pubkey'],
        ['param', 'method', 'GET'],
        ['param', 'path', '/api/test'],
        ['bid', '500'], // 500 millisats, but price is 1000 sats = 1000000 millisats
      ],
    })
    subscribeManyState.callback!(event)

    await new Promise((r) => setTimeout(r, 50))

    const errorCall = mockPublish.mock.calls.find(
      (call) => {
        const evt = call[1] as { kind: number; tags: string[][] }
        return evt.kind === FEEDBACK_KIND &&
          evt.tags.some((t: string[]) => t[0] === 'message' && t[1] === 'price-exceeds-bid')
      },
    )
    expect(errorCall).toBeDefined()

    await handle.close()
  })

  it('publishes error feedback on payment timeout', async () => {
    mockProxyRequest.mockResolvedValueOnce({
      status: 'payment-required',
      bolt11: 'lnbc...',
      macaroon: 'mac',
      paymentHash: 'b'.repeat(64),
      amountSats: 100,
      statusToken: 'tok',
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ settled: false }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const handle = await serve({
      secretKey: SECRET_KEY,
      relays: ['wss://r.test'],
      endpoint: 'https://e.test',
      paymentTimeoutMs: 50,
      pollIntervalMs: 10,
    })
    subscribeManyState.callback!(makeJobEvent())

    await new Promise((r) => setTimeout(r, 300))

    const timeoutCall = mockPublish.mock.calls.find(
      (call) => {
        const evt = call[1] as { kind: number; tags: string[][] }
        return evt.kind === FEEDBACK_KIND &&
          evt.tags.some((t: string[]) => t[0] === 'message' && t[1] === 'payment-timeout')
      },
    )
    expect(timeoutCall).toBeDefined()

    vi.unstubAllGlobals()
    await handle.close()
  })

  it('publishes error for invalid path', async () => {
    // Make validatePath throw for this test
    mockValidatePath.mockImplementation(() => {
      throw new Error('Path not allowed: /admin')
    })

    const handle = await serve({
      secretKey: SECRET_KEY,
      relays: ['wss://r.test'],
      endpoint: 'https://e.test',
    })
    subscribeManyState.callback!(makeJobEvent({
      tags: [
        ['p', 'dvm-pubkey'],
        ['param', 'method', 'GET'],
        ['param', 'path', '/admin'],
      ],
    }))

    await new Promise((r) => setTimeout(r, 50))

    const errorCall = mockPublish.mock.calls.find(
      (call) => {
        const evt = call[1] as { kind: number; tags: string[][] }
        return evt.kind === FEEDBACK_KIND &&
          evt.tags.some((t: string[]) => t[0] === 'message' && t[1] === 'invalid-path')
      },
    )
    expect(errorCall).toBeDefined()

    await handle.close()
  })

  it('retries with L402 after payment and publishes result', async () => {
    mockProxyRequest
      .mockResolvedValueOnce({
        status: 'payment-required',
        bolt11: 'lnbc...',
        macaroon: 'mac-token',
        paymentHash: 'c'.repeat(64),
        amountSats: 100,
        statusToken: 'status-tok',
      })
      .mockResolvedValueOnce({
        status: 'success',
        body: '{"paid":"data"}',
        contentType: 'application/json',
      })

    // Mock fetch for polling — settles immediately
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ settled: true, preimage: 'preimage-abc' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const handle = await serve({
      secretKey: SECRET_KEY,
      relays: ['wss://r.test'],
      endpoint: 'https://e.test',
      pollIntervalMs: 10,
      paymentTimeoutMs: 5000,
    })
    subscribeManyState.callback!(makeJobEvent())

    await new Promise((r) => setTimeout(r, 200))

    // Second proxyRequest call should include L402 credentials
    expect(mockProxyRequest).toHaveBeenCalledTimes(2)
    const secondCall = mockProxyRequest.mock.calls[1][0]
    expect(secondCall.l402).toEqual({ macaroon: 'mac-token', preimage: 'preimage-abc' })

    // Result should be published
    const resultCall = mockPublish.mock.calls.find(
      (call) => (call[1] as { kind: number }).kind === RESULT_KIND,
    )
    expect(resultCall).toBeDefined()
    expect((resultCall![1] as { content: string }).content).toBe('{"paid":"data"}')

    vi.unstubAllGlobals()
    await handle.close()
  })

  it('close() cleans up subscription and pool', async () => {
    const handle = await serve({ secretKey: SECRET_KEY, relays: ['wss://r.test'], endpoint: 'https://e.test' })

    await handle.close()

    expect(mockSubClose).toHaveBeenCalled()
    const pool = vi.mocked(SimplePool).mock.instances[0] as unknown as { close: ReturnType<typeof vi.fn> }
    expect(pool.close).toHaveBeenCalledWith(['wss://r.test'])
  })
})
