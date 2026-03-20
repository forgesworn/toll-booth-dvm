import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import type { ServeOptions, DvmHandle } from './types.js'
import { JOB_KIND, RESULT_KIND, FEEDBACK_KIND } from './constants.js'
import { proxyRequest, validatePath } from './proxy.js'
import { announce } from './announce.js'
import { hexToBytes, validateSecretKey } from './utils.js'

const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_MAX_PENDING_JOBS = 10
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_PAYMENT_TIMEOUT_MS = 300_000
const DEFAULT_MAX_BODY_BYTES = 65_536
const SEEN_TTL_MS = 600_000

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
  } = options

  const sk = hexToBytes(options.secretKey)
  const dvmPubkey = getPublicKey(sk)

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
        seen.set(id, Date.now())
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
        const priceMillisats = result.amountSats * 1000
        if (priceMillisats > bidMillisats) {
          await publishFeedback(event, 'error', 'price-exceeds-bid')
          return
        }
      }

      await publishPaymentRequired(event, result.amountSats, result.bolt11)

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
        timeoutMs: requestTimeoutMs,
      })

      if (paidResult.status === 'success') {
        await publishResult(event, paidResult.body)
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
    const tags: string[][] = [
      ['e', event.id],
      ['p', event.pubkey],
      ['status', status],
    ]
    if (message) tags.push(['message', message])
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
          ['e', event.id],
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

  function publishResult(event: JobEvent, body: string): Promise<unknown> {
    const resultEvent = finalizeEvent(
      {
        kind: RESULT_KIND,
        content: body,
        tags: [
          ['e', event.id],
          ['p', event.pubkey],
        ],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    )
    return Promise.all(pool.publish(relays, resultEvent))
  }

  return {
    async close() {
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
      const url = `${endpoint.replace(/\/$/, '')}/invoice-status/${paymentHash}?token=${statusToken}`
      const response = await fetch(url, { signal })
      if (response.ok) {
        const data = (await response.json()) as { settled?: boolean; preimage?: string }
        if (data.settled && data.preimage) return data.preimage
      }
    } catch {
      // Network error — retry
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return null
}
