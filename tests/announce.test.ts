import { describe, it, expect, vi } from 'vitest'
import { announce } from '../src/announce.js'
import { HANDLER_KIND } from '../src/constants.js'

vi.mock('nostr-tools/pure', () => ({
  finalizeEvent: vi.fn((template: { kind: number; content: string; tags: string[][] }, _sk: Uint8Array) => ({
    ...template,
    id: 'abc123',
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

  it('returns an Announcement with eventId and relays', async () => {
    const result = await announce(boothConfig, options)
    expect(result.eventId).toBe('abc123')
    expect(result.relays).toEqual(['wss://relay.damus.io'])
  })

  it('builds a kind 31990 event', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    expect(finalizeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: HANDLER_KIND }),
      expect.any(Uint8Array),
    )
  })

  it('includes pricing in content JSON', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    const call = vi.mocked(finalizeEvent).mock.calls[0]
    const content = JSON.parse(call[0].content as string)
    expect(content.pricing).toEqual([
      { capability: '/api/route', price: 1000, currency: 'sats' },
    ])
  })

  it('includes k=5800 tag', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure')
    await announce(boothConfig, options)
    const call = vi.mocked(finalizeEvent).mock.calls[0]
    const tags = call[0].tags as string[][]
    expect(tags).toContainEqual(['k', '5800'])
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
