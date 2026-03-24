import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import type { ServeOptions, DvmHandle } from './types.js'
import { JOB_KIND, RESULT_KIND, FEEDBACK_KIND } from './constants.js'
import { proxyRequest, validatePath, validateMethod } from './proxy.js'
import { announce } from './announce.js'
import { hexToBytes, validateSecretKey } from './utils.js'

const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_MAX_PENDING_JOBS = 10
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_PAYMENT_TIMEOUT_MS = 300_000
const DEFAULT_MAX_BODY_BYTES = 65_536
const SEEN_TTL_MS = 600_000
const MAX_SEEN_ENTRIES = 100_000
const MAX_EVENT_AGE_SECS = 600
const PAYMENT_HASH_RE = /^[0-9a-f]{64}$/
const skRegistry = new FinalizationRegistry<Uint8Array>((sk) => sk.fill(0))

/**
 * Start the DVM relay loop — subscribes to kind 5800 job requests and proxies
 * them to the upstream toll-booth endpoint.
 *
 * Handles the full L402 payment flow: relays bolt11 invoices via kind 7000
 * feedback events, polls for Lightning settlement, and publishes results as
 * kind 6800. The DVM never holds or forwards funds.
 *
 * @param options - Relay list, upstream endpoint, timeouts, and optional announce config
 * @returns A handle with a `close()` method for graceful shutdown
 */
export async function serve(options: ServeOptions): Promise<DvmHandle> {
  validateSecretKey(options.secretKey)

  const {
    relays,
    endpoint,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxPendingJobs = DEFAULT_MAX_PENDING_JOBS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    paymentTimeoutMs = DEFAULT_PAYMENT_TIMEOUT_MS,
    allowedPaths,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    maxResponseBytes,
  } = options

  const sk = hexToBytes(options.secretKey)
  const dvmPubkey = getPublicKey(sk)
  const relayHint = relays[0] ?? ''

  // Backstop: zeroise sk if the handle is garbage-collected without calling close()
  const sentinel = {}
  skRegistry.register(sentinel, sk, sentinel)

  const seen = new Map<string, number>()
  const pending = new Set<string>()
  const abortControllers = new Map<string, AbortController>()

  const evictInterval = setInterval(() => {
    const cutoff = Date.now() - SEEN_TTL_MS
    for (const [id, ts] of seen) {
      if (ts < cutoff) seen.delete(id)
    }
  }, SEEN_TTL_MS / 2)

  if (options.announceOnStart && options.boothConfig) {
    await announce(options.boothConfig, {
      secretKey: options.secretKey,
      relays,
      urls: [endpoint],
      about: options.about ?? options.boothConfig.serviceName ?? 'toll-booth-dvm',
    })
  }

  const pool = new SimplePool()

  const sub = pool.subscribeMany(
    relays,
    { kinds: [JOB_KIND], '#p': [dvmPubkey] },
    {
      onevent(event: JobEvent) {
        const id = event.id
        if (seen.has(id)) return
        if (seen.size >= MAX_SEEN_ENTRIES) return
        const now = Date.now()
        const eventAge = Math.abs(Math.floor(now / 1000) - event.created_at)
        if (eventAge > MAX_EVENT_AGE_SECS) return
        seen.set(id, now)
        if (pending.size >= maxPendingJobs) return
        pending.add(id)
        handleJob(event).finally(() => pending.delete(id))
      },
    },
  )

  async function handleJob(event: JobEvent): Promise<void> {
    const params = extractParams(event.tags)
    const controller = new AbortController()
    abortControllers.set(event.id, controller)

    try {
      validateMethod(params.method)
    } catch {
      await publishFeedback(event, 'error', 'method-not-allowed')
      return
    }

    try {
      validatePath(params.path, allowedPaths)
    } catch {
      await publishFeedback(event, 'error', 'invalid-path')
      return
    }

    try {
      const result = await proxyRequest({
        endpoint,
        method: params.method,
        path: params.path,
        body: params.body,
        accept: params.accept,
        maxBodyBytes,
        maxResponseBytes,
        timeoutMs: requestTimeoutMs,
      })

      if (result.status === 'success') {
        await publishResult(event, result.body)
        return
      }

      if (result.status === 'error') {
        await publishFeedback(event, 'error', `upstream-${result.statusCode}`)
        return
      }

      // payment-required
      const bidTag = event.tags.find((t) => t[0] === 'bid')
      if (bidTag) {
        const bidMillisats = parseInt(bidTag[1], 10)
        if (isNaN(bidMillisats)) {
          await publishFeedback(event, 'error', 'invalid-bid')
          return
        }
        const priceMillisats = result.amountSats * 1000
        if (priceMillisats > bidMillisats) {
          await publishFeedback(event, 'error', 'price-exceeds-bid')
          return
        }
      }

      await publishPaymentRequired(event, result.amountSats, result.bolt11)

      if (!PAYMENT_HASH_RE.test(result.paymentHash)) {
        await publishFeedback(event, 'error', 'invalid-payment-hash')
        return
      }

      const preimage = await pollForPayment(
        endpoint,
        result.paymentHash,
        result.statusToken,
        pollIntervalMs,
        paymentTimeoutMs,
        controller.signal,
      )

      if (!preimage) {
        await publishFeedback(event, 'error', 'payment-timeout')
        return
      }

      const paidResult = await proxyRequest({
        endpoint,
        method: params.method,
        path: params.path,
        body: params.body,
        accept: params.accept,
        l402: { macaroon: result.macaroon, preimage },
        maxBodyBytes,
        maxResponseBytes,
        timeoutMs: requestTimeoutMs,
      })

      if (paidResult.status === 'success') {
        await publishResult(event, paidResult.body, result.amountSats)
      } else {
        await publishFeedback(event, 'error', 'upstream-error-after-payment')
      }
    } catch {
      await publishFeedback(event, 'error', 'internal-error')
    } finally {
      abortControllers.delete(event.id)
    }
  }

  function publishFeedback(event: JobEvent, status: string, message?: string): Promise<unknown> {
    const statusTag = message ? ['status', status, message] : ['status', status]
    const tags: string[][] = [
      ['e', event.id, relayHint],
      ['p', event.pubkey],
      statusTag,
    ]
    const feedbackEvent = finalizeEvent(
      { kind: FEEDBACK_KIND, content: '', tags, created_at: Math.floor(Date.now() / 1000) },
      sk,
    )
    return Promise.all(pool.publish(relays, feedbackEvent))
  }

  function publishPaymentRequired(event: JobEvent, amountSats: number, bolt11: string): Promise<unknown> {
    const amountMillisats = String(amountSats * 1000)
    const feedbackEvent = finalizeEvent(
      {
        kind: FEEDBACK_KIND,
        content: '',
        tags: [
          ['e', event.id, relayHint],
          ['p', event.pubkey],
          ['status', 'payment-required'],
          ['amount', amountMillisats, bolt11],
        ],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    )
    return Promise.all(pool.publish(relays, feedbackEvent))
  }

  function publishResult(event: JobEvent, body: string, amountSats?: number): Promise<unknown> {
    const tags: string[][] = [
      ['e', event.id, relayHint],
      ['p', event.pubkey],
      ['request', JSON.stringify(event)],
    ]
    if (amountSats !== undefined) tags.push(['amount', String(amountSats * 1000)])
    const resultEvent = finalizeEvent(
      {
        kind: RESULT_KIND,
        content: body,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    )
    return Promise.all(pool.publish(relays, resultEvent))
  }

  return {
    _sentinel: sentinel, // prevent GC while handle is alive
    async close() {
      skRegistry.unregister(sentinel)
      clearInterval(evictInterval)
      sub.close()
      for (const controller of abortControllers.values()) {
        controller.abort()
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      pool.close(relays)
      sk.fill(0)
    },
  }
}

interface JobEvent {
  id: string
  pubkey: string
  kind: number
  content: string
  tags: string[][]
  created_at: number
  sig: string
}

interface JobParams {
  method: string
  path: string
  body?: string
  accept?: string
}

function extractParams(tags: string[][]): JobParams {
  const params: Record<string, string> = {}
  for (const tag of tags) {
    if (tag[0] === 'param' && tag.length >= 3) {
      params[tag[1]] = tag[2]
    }
  }
  return {
    method: params['method'] ?? 'GET',
    path: params['path'] ?? '/',
    body: params['body'],
    accept: params['accept'],
  }
}

async function pollForPayment(
  endpoint: string,
  paymentHash: string,
  statusToken: string,
  intervalMs: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline && !signal.aborted) {
    try {
      const url = `${endpoint.replace(/\/$/, '')}/invoice-status/${paymentHash}?token=${encodeURIComponent(statusToken)}`
      const response = await fetch(url, { signal })
      if (response.ok) {
        const data = (await response.json()) as { settled?: boolean; preimage?: string }
        if (data.settled && data.preimage && PAYMENT_HASH_RE.test(data.preimage)) return data.preimage
      }
    } catch {
      // Network error — retry
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return null
}
