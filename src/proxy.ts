export interface ProxyRequestOptions {
  endpoint: string
  method: string
  path: string
  body?: string
  accept?: string
  l402?: { macaroon: string; preimage: string }
  maxBodyBytes?: number
  timeoutMs?: number
  // NOTE: proxy support is a stub in v1. Node.js fetch() does not natively
  // support SOCKS5. Real Tor proxy support requires undici or socks-proxy-agent.
  proxy?: string
}

export interface ProxySuccess {
  status: 'success'
  body: string
  contentType: string
}

export interface ProxyPaymentRequired {
  status: 'payment-required'
  bolt11: string
  macaroon: string
  paymentHash: string
  amountSats: number
  statusToken: string
}

export interface ProxyError {
  status: 'error'
  statusCode: number
  body: string
}

export type ProxyResult = ProxySuccess | ProxyPaymentRequired | ProxyError

export function validatePath(path: string, allowedPaths?: string[]): void {
  if (path.includes('..')) throw new Error('Invalid path: contains ..')
  if (path.includes('//')) throw new Error('Invalid path: contains //')
  if (allowedPaths && !allowedPaths.includes(path)) {
    throw new Error(`Path not allowed: ${path}`)
  }
}

export async function proxyRequest(options: ProxyRequestOptions): Promise<ProxyResult> {
  const { endpoint, method, path, body, accept, l402, maxBodyBytes, timeoutMs } = options

  if (body && maxBodyBytes && Buffer.byteLength(body) > maxBodyBytes) {
    throw new Error(`Body exceeds maximum size of ${maxBodyBytes} bytes`)
  }

  validatePath(path)

  const url = `${endpoint.replace(/\/$/, '')}${path}`

  const headers: Record<string, string> = {}
  if (accept) headers['Accept'] = accept
  if (body) headers['Content-Type'] = 'application/json'
  if (l402) headers['Authorization'] = `L402 ${l402.macaroon}:${l402.preimage}`

  const controller = new AbortController()
  const timeout = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: controller.signal,
    })

    if (response.status === 402) {
      const json = await response.json()
      const l402Data = json.l402
      return {
        status: 'payment-required',
        bolt11: l402Data.bolt11,
        macaroon: l402Data.macaroon,
        paymentHash: l402Data.payment_hash,
        amountSats: l402Data.amount_sats,
        statusToken: l402Data.status_token,
      }
    }

    if (response.status >= 200 && response.status < 300) {
      return {
        status: 'success',
        body: await response.text(),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      }
    }

    return {
      status: 'error',
      statusCode: response.status,
      body: await response.text(),
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
