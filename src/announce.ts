import { finalizeEvent } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import type { BoothConfigLike, AnnounceOptions, Announcement } from './types.js'
import { mapBoothConfig, mapPaidServices } from './mapper.js'
import { HANDLER_KIND, PAID_SERVICES_KIND } from './constants.js'
import { hexToBytes, validateSecretKey } from './utils.js'

/**
 * Publish a NIP-89 kind 31990 handler event and a kind 31402 paid service
 * announcement so Nostr clients can discover this DVM and its paid API.
 *
 * Maps the toll-booth pricing configuration into signed Nostr events and publishes
 * them to the specified relays. The secret key is zeroised after signing.
 *
 * @param boothConfig - Pricing and service metadata from your toll-booth configuration
 * @param options - Nostr identity, relay list, and optional discovery metadata
 * @returns The published event IDs and relay list
 */
export async function announce(
  boothConfig: BoothConfigLike,
  options: AnnounceOptions,
): Promise<Announcement> {
  validateSecretKey(options.secretKey)
  if (options.relays.length === 0) {
    throw new Error('At least one relay is required')
  }
  if (options.urls.length === 0) {
    throw new Error('At least one URL is required')
  }

  const mapped = mapBoothConfig(boothConfig, options)
  const paidService = mapPaidServices(boothConfig, options)
  const sk = hexToBytes(options.secretKey)
  const now = Math.floor(Date.now() / 1000)

  const handlerEvent = finalizeEvent(
    {
      kind: HANDLER_KIND,
      content: JSON.stringify(mapped.content),
      tags: mapped.tags,
      created_at: now,
    },
    sk,
  )

  const paidServiceEvent = finalizeEvent(
    {
      kind: PAID_SERVICES_KIND,
      content: paidService.content,
      tags: paidService.tags,
      created_at: now,
    },
    sk,
  )

  // Zeroise secret key bytes
  sk.fill(0)

  const pool = new SimplePool()
  try {
    await Promise.allSettled(
      options.relays.flatMap((relay) => [
        pool.publish([relay], handlerEvent),
        pool.publish([relay], paidServiceEvent),
      ]),
    )
  } finally {
    pool.close(options.relays)
  }

  return {
    eventId: handlerEvent.id,
    paidServiceEventId: paidServiceEvent.id,
    relays: options.relays,
  }
}
