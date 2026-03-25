import { describe, it, expect, vi, beforeEach } from 'vitest'
import { announce } from '../src/announce.js'
import { HANDLER_KIND, PAID_SERVICES_KIND } from '../src/constants.js'

let callCount = 0
vi.mock('nostr-tools/pure', () => ({
  finalizeEvent: vi.fn((template: { kind: number; content: string; tags: string[][] }, _sk: Uint8Array) => ({
    ...template,
    id: `event-${++callCount}`,
    pubkey: 'pubkey123',
    sig: 'sig123',
    created_at: 1234567890,
  })),
  getPublicKey: vi.fn(() => 'pubkey123'),
}))

vi.mock('nostr-tools/pool', () => {
  const publishFn = vi.fn().mockResolvedValue('ok')
  const SimplePool = vi.fn(function (this: object) {
    Object.assign(this, {
      publish: publishFn,
      close: vi.fn(),
    })
  })
  return { SimplePool }
})

describe('announce', () => {
  const boothConfig = {
    pricing: { '/api/route': 1000 },
    serviceName: 'Test Service',
  }

  const options = {
    secretKey: 'a'.repeat(64),
    relays: ['wss://relay.damus.io'],
    urls: ['https://example.com'],
    about: 'A test DVM service',
    topics: ['test'],
  }

  beforeEach(() => {
    callCount = 0
    vi.clearAllMocks()
  })

  it('returns an Announcement with both event IDs and relays', async () => {
    const result = await announce(boothConfig, options)
    expect(result.eventId).toBe('event-1')
    expect(result.paidServiceEventId).toBe('event-2')
    expect(result.relays).toEqual(['wss://relay.damus.io'])
  })

  it('builds a kind 31990 handler event', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    expect(finalizeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: HANDLER_KIND }),
      expect.any(Uint8Array),
    )
  })

  it('builds a kind 31402 paid service event', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    expect(finalizeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: PAID_SERVICES_KIND }),
      expect.any(Uint8Array),
    )
  })

  it('includes pricing in kind 31990 content JSON', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    const handlerCall = vi.mocked(finalizeEvent).mock.calls[0]
    const content = JSON.parse(handlerCall[0].content as string)
    expect(content.pricing).toEqual([
      { capability: '/api/route', price: 1000, currency: 'sats' },
    ])
  })

  it('includes k=5800 tag in kind 31990 event', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    const handlerCall = vi.mocked(finalizeEvent).mock.calls[0]
    const tags = handlerCall[0].tags as string[][]
    expect(tags).toContainEqual(['k', '5800'])
  })

  it('includes required tags in kind 31402 event', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    const paidCall = vi.mocked(finalizeEvent).mock.calls[1]
    const tags = paidCall[0].tags as string[][]
    expect(tags).toContainEqual(['d', 'test-service'])
    expect(tags).toContainEqual(['name', 'Test Service'])
    expect(tags).toContainEqual(['url', 'https://example.com'])
    expect(tags).toContainEqual(['summary', 'A test DVM service'])
  })

  it('includes pmi tag in kind 31402 event', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    const paidCall = vi.mocked(finalizeEvent).mock.calls[1]
    const tags = paidCall[0].tags as string[][]
    expect(tags).toContainEqual(['pmi', 'l402', 'lightning'])
  })

  it('includes price tags in kind 31402 event', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    const paidCall = vi.mocked(finalizeEvent).mock.calls[1]
    const tags = paidCall[0].tags as string[][]
    expect(tags).toContainEqual(['price', '/api/route', '1000', 'sats'])
  })

  it('includes topic tags in kind 31402 event', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    const paidCall = vi.mocked(finalizeEvent).mock.calls[1]
    const tags = paidCall[0].tags as string[][]
    expect(tags).toContainEqual(['t', 'test'])
  })

  it('includes capabilities in kind 31402 content', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    const paidCall = vi.mocked(finalizeEvent).mock.calls[1]
    const content = JSON.parse(paidCall[0].content as string)
    expect(content.capabilities).toEqual([
      { name: '/api/route', description: '/api/route endpoint', endpoint: '/api/route' },
    ])
  })

  it('validates secretKey length', async () => {
    await expect(
      announce(boothConfig, { ...options, secretKey: 'tooshort' }),
    ).rejects.toThrow('secretKey must be 64 hex characters')
  })

  it('validates relays is non-empty', async () => {
    await expect(
      announce(boothConfig, { ...options, relays: [] }),
    ).rejects.toThrow('At least one relay is required')
  })

  it('validates urls is non-empty', async () => {
    await expect(
      announce(boothConfig, { ...options, urls: [] }),
    ).rejects.toThrow('At least one URL is required')
  })
})
