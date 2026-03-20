import { describe, it, expect, vi, beforeEach } from 'vitest'
import { proxyRequest, validatePath } from '../src/proxy.js'

describe('validatePath', () => {
  it('allows a simple path', () => {
    expect(() => validatePath('/api/isochrone')).not.toThrow()
  })
  it('rejects path traversal with ..', () => {
    expect(() => validatePath('/api/../admin')).toThrow('Invalid path')
  })
  it('rejects double slashes', () => {
    expect(() => validatePath('/api//isochrone')).toThrow('Invalid path')
  })
  it('rejects paths not in allowedPaths when set', () => {
    expect(() => validatePath('/api/secret', ['/api/isochrone', '/api/matrix'])).toThrow('Path not allowed')
  })
  it('allows paths in allowedPaths', () => {
    expect(() => validatePath('/api/isochrone', ['/api/isochrone', '/api/matrix'])).not.toThrow()
  })
})

describe('proxyRequest', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
  })

  it('returns upstream response when no 402', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      text: () => Promise.resolve('{"result":"ok"}'),
      headers: new Headers({ 'content-type': 'application/json' }),
    })
    const result = await proxyRequest({ endpoint: 'https://example.com', method: 'GET', path: '/api/test' })
    expect(result.status).toBe('success')
    if (result.status === 'success') expect(result.body).toBe('{"result":"ok"}')
  })

  it('returns payment-required with bolt11 on 402', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 402,
      json: () => Promise.resolve({
        l402: {
          bolt11: 'lnbc10n1...',
          macaroon: 'macaroon123',
          payment_hash: 'abc123',
          amount_sats: 1000,
          status_token: 'tok123',
        },
      }),
      headers: new Headers(),
    })
    const result = await proxyRequest({ endpoint: 'https://example.com', method: 'POST', path: '/api/query', body: '{"q":"test"}' })
    expect(result.status).toBe('payment-required')
    if (result.status === 'payment-required') {
      expect(result.bolt11).toBe('lnbc10n1...')
      expect(result.macaroon).toBe('macaroon123')
      expect(result.paymentHash).toBe('abc123')
      expect(result.amountSats).toBe(1000)
      expect(result.statusToken).toBe('tok123')
    }
  })

  it('retries with L402 auth header when credentials provided', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      text: () => Promise.resolve('{"data":"paid"}'),
      headers: new Headers({ 'content-type': 'application/json' }),
    })
    await proxyRequest({
      endpoint: 'https://example.com', method: 'GET', path: '/api/test',
      l402: { macaroon: 'mac123', preimage: 'pre123' },
    })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/api/test',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'L402 mac123:pre123' }),
      }),
    )
  })

  it('rejects body exceeding maxBodyBytes', async () => {
    await expect(
      proxyRequest({ endpoint: 'https://example.com', method: 'POST', path: '/api/test', body: 'x'.repeat(100), maxBodyBytes: 50 }),
    ).rejects.toThrow('Body exceeds maximum size')
  })

  it('returns error for non-402/non-2xx responses', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
      headers: new Headers(),
    })
    const result = await proxyRequest({ endpoint: 'https://example.com', method: 'GET', path: '/api/test' })
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.statusCode).toBe(500)
      expect(result.body).toBe('Internal Server Error')
    }
  })
})
