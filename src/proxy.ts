const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576 // 1 MB
const BOLT11_PREFIX_RE = /^ln(bc|tb|bcrt)/

/** Options for a single proxied HTTP request to the upstream toll-booth endpoint. */
export interface ProxyRequestOptions {
  endpoint: string
  method: string
  path: string
  body?: string
  accept?: string
  /** L402 credential for authenticated retries after payment. */
  l402?: { macaroon: string; preimage: string }
  maxBodyBytes?: number
  /** Max upstream response size in bytes. Default: 1 MB. */
  maxResponseBytes?: number
  timeoutMs?: number
  // NOTE: proxy support is a stub in v1. Node.js fetch() does not natively
  // support SOCKS5. Real Tor proxy support requires undici or socks-proxy-agent.
  proxy?: string
}

/** Upstream returned a 2xx response. */
export interface ProxySuccess {
  status: 'success'
  body: string
  contentType: string
}

/** Upstream returned HTTP 402 with an L402 challenge. */
export interface ProxyPaymentRequired {
  status: 'payment-required'
  bolt11: string
  macaroon: string
  paymentHash: string
  amountSats: number
  statusToken: string
}

/** Upstream returned a non-2xx, non-402 error. */
export interface ProxyError {
  status: 'error'
  statusCode: number
  body: string
}

/** Discriminated union of all possible proxy outcomes. */
export type ProxyResult = ProxySuccess | ProxyPaymentRequired | ProxyError

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Validate a request path against traversal attacks and an optional whitelist.
 * Decodes percent-encoded sequences before checking to prevent `%2e%2e` bypass.
 * Throws if the path contains `..`, `//`, does not start with `/`, or is not in the allowed list.
 */
export function validatePath(path: string, allowedPaths?: string[]): void {
  if (!path.startsWith('/')) throw new Error('Invalid path: must start with /')

  // Decode percent-encoded sequences to catch %2e%2e, %2f, etc.
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw new Error('Invalid path: malformed percent encoding')
  }

  if (decoded.includes('..')) throw new Error('Invalid path: contains ..')
  if (decoded.includes('//')) throw new Error('Invalid path: contains //')

  // Also check the raw path for double-encoded variants
  if (path.includes('..')) throw new Error('Invalid path: contains ..')
  if (path.includes('//')) throw new Error('Invalid path: contains //')

  if (allowedPaths && !allowedPaths.includes(decoded)) {
    throw new Error(`Path not allowed: ${decoded}`)
  }
}

/**
 * Validate that an HTTP method is in the allowed set.
 * Prevents forwarding arbitrary methods (e.g. DELETE) to the upstream.
 */
export function validateMethod(method: string, allowedMethods?: Set<string>): void {
  const allowed = allowedMethods ?? ALLOWED_METHODS
  if (!allowed.has(method.toUpperCase())) {
    throw new Error(`Method not allowed: ${method}`)
  }
}

async function readResponseText(response: { text(): Promise<string> }, maxBytes: number): Promise<string> {
  const text = await response.text()
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error(`Response exceeds maximum size of ${maxBytes} bytes`)
  }
  return text
}

/**
 * Send an HTTP request to the upstream toll-booth endpoint and return
 * the result as a discriminated union: success, payment-required, or error.
 */
export async function proxyRequest(options: ProxyRequestOptions): Promise<ProxyResult> {
  const { endpoint, method, path, body, accept, l402, maxBodyBytes, timeoutMs,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = options

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
      const l402Data = json?.l402
      if (
        typeof l402Data?.bolt11 !== 'string' ||
        typeof l402Data?.macaroon !== 'string' ||
        typeof l402Data?.payment_hash !== 'string' ||
        typeof l402Data?.amount_sats !== 'number' ||
        typeof l402Data?.status_token !== 'string' ||
        !Number.isFinite(l402Data.amount_sats) ||
        l402Data.amount_sats <= 0 ||
        !BOLT11_PREFIX_RE.test(l402Data.bolt11)
      ) {
        return { status: 'error', statusCode: 402, body: 'Malformed L402 challenge' }
      }
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
        body: await readResponseText(response, maxResponseBytes),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      }
    }

    return {
      status: 'error',
      statusCode: response.status,
      body: await readResponseText(response, maxResponseBytes),
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
