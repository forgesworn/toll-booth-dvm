import { describe, it, expect } from 'vitest'
import { mapBoothConfig } from '../src/mapper.js'

describe('mapBoothConfig', () => {
  it('maps flat pricing to content JSON', () => {
    const result = mapBoothConfig(
      { pricing: { '/api/route': 1000 }, serviceName: 'My Service' },
      { secretKey: 'a'.repeat(64), relays: ['wss://relay.damus.io'], urls: ['https://example.com'], about: 'A test service' },
    )
    expect(result.content.name).toBe('My Service')
    expect(result.content.about).toBe('A test service')
    expect(result.content.pricing).toEqual([{ capability: '/api/route', price: 1000, currency: 'sats' }])
    expect(result.content.urls).toEqual(['https://example.com'])
    expect(result.content.paymentMethods).toEqual(['lightning'])
    expect(result.identifier).toBe('my-service')
  })

  it('maps PriceInfo with sats and usd', () => {
    const result = mapBoothConfig(
      { pricing: { '/api/query': { sats: 500, usd: 10 } } },
      { secretKey: 'a'.repeat(64), relays: ['wss://relay.damus.io'], urls: ['https://example.com'], about: 'Dual currency' },
    )
    expect(result.content.pricing).toEqual([
      { capability: '/api/query', price: 500, currency: 'sats' },
      { capability: '/api/query', price: 10, currency: 'usd' },
    ])
  })

  it('extracts default from tiered pricing', () => {
    const result = mapBoothConfig(
      { pricing: { '/api/data': { default: 2000, premium: 5000 } } },
      { secretKey: 'a'.repeat(64), relays: ['wss://relay.damus.io'], urls: ['https://example.com'], about: 'Tiered' },
    )
    expect(result.content.pricing).toEqual([{ capability: '/api/data', price: 2000, currency: 'sats' }])
  })

  it('auto-derives payment methods from config', () => {
    const result = mapBoothConfig(
      { pricing: { '/': 100 }, hasBackend: true, xcashu: { mints: ['https://mint.example'] } },
      { secretKey: 'a'.repeat(64), relays: ['wss://relay.damus.io'], urls: ['https://example.com'], about: 'Multi-pay' },
    )
    expect(result.content.paymentMethods).toEqual(['lightning', 'cashu'])
  })

  it('defaults to lightning when hasBackend is undefined', () => {
    const result = mapBoothConfig(
      { pricing: { '/': 100 } },
      { secretKey: 'a'.repeat(64), relays: ['wss://relay.damus.io'], urls: ['https://example.com'], about: 'Default' },
    )
    expect(result.content.paymentMethods).toEqual(['lightning'])
  })

  it('uses identifier override when provided', () => {
    const result = mapBoothConfig(
      { pricing: { '/': 100 }, serviceName: 'Ignored Name' },
      { secretKey: 'a'.repeat(64), relays: ['wss://relay.damus.io'], urls: ['https://example.com'], about: 'Override test', identifier: 'custom-id' },
    )
    expect(result.identifier).toBe('custom-id')
  })

  it('builds tags array with k, d, and t tags', () => {
    const result = mapBoothConfig(
      { pricing: { '/': 100 }, serviceName: 'Test' },
      { secretKey: 'a'.repeat(64), relays: ['wss://relay.damus.io'], urls: ['https://example.com'], about: 'Tag test', topics: ['routing', 'geospatial'] },
    )
    expect(result.tags).toContainEqual(['d', 'test'])
    expect(result.tags).toContainEqual(['k', '5800'])
    expect(result.tags).toContainEqual(['t', 'routing'])
    expect(result.tags).toContainEqual(['t', 'geospatial'])
  })
})
