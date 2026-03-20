import { finalizeEvent } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import type { BoothConfigLike, AnnounceOptions, Announcement } from './types.js'
import { mapBoothConfig } from './mapper.js'
import { HANDLER_KIND } from './constants.js'
import { hexToBytes, validateSecretKey } from './utils.js'

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
  const sk = hexToBytes(options.secretKey)

  const event = finalizeEvent(
    {
      kind: HANDLER_KIND,
      content: JSON.stringify(mapped.content),
      tags: mapped.tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    sk,
  )

  // Zeroize secret key bytes
  sk.fill(0)

  const pool = new SimplePool()
  try {
    await Promise.allSettled(
      options.relays.map((relay) => pool.publish([relay], event)),
    )
  } finally {
    pool.close(options.relays)
  }

  return { eventId: event.id, relays: options.relays }
}
