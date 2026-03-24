/** Price for a single capability, in sats and/or USD. */
export interface PriceInfo {
  sats?: number
  usd?: number
}

/** Toll-booth pricing configuration. Maps endpoint paths to prices. */
export interface BoothConfigLike {
  /** Map of path → price. Values can be a sat amount, a PriceInfo, or a nested map with a `default` key. */
  pricing: Record<string, number | PriceInfo | Record<string, number | PriceInfo>>
  /** Human-readable service name, used in the NIP-89 announcement. */
  serviceName?: string
  /** Whether the upstream has a Lightning backend. Defaults to true. */
  hasBackend?: boolean
  /** Cashu mint configuration for ecash payments. */
  xcashu?: { mints: string[] }
}

/** Options for publishing a NIP-89 kind 31990 handler event. */
export interface AnnounceOptions {
  /** Hex-encoded 32-byte Nostr secret key. Zeroised after signing. */
  secretKey: string
  /** Nostr relay URLs to publish the announcement to. */
  relays: string[]
  /** Public URLs where the toll-booth endpoint is reachable. */
  urls: string[]
  /** Human-readable description of the service. */
  about: string
  /** Topic tags for discoverability (e.g. 'routing', 'maps'). */
  topics?: string[]
  /** NIP-89 `d` tag identifier. Defaults to slugified service name. */
  identifier?: string
  /** URL to a profile picture for the DVM. */
  picture?: string
  /** Semantic version string for the service. */
  version?: string
}

/** Options for starting the DVM relay loop. */
export interface ServeOptions {
  /** Hex-encoded 32-byte Nostr secret key. Zeroised on close. */
  secretKey: string
  /** Nostr relay URLs to subscribe on. */
  relays: string[]
  /** Upstream toll-booth base URL (e.g. 'http://localhost:3000'). */
  endpoint: string
  /** Service description for announcements. */
  about?: string
  /** Publish a NIP-89 kind 31990 handler event on startup. */
  announceOnStart?: boolean
  /** Required if `announceOnStart` is true. */
  boothConfig?: BoothConfigLike
  /** Payment settlement poll interval in ms. Default: 2000. */
  pollIntervalMs?: number
  /** Max concurrent in-flight jobs. Default: 10. */
  maxPendingJobs?: number
  /** Upstream HTTP request timeout in ms. Default: 30000. */
  requestTimeoutMs?: number
  /** Time to wait for Lightning settlement in ms. Default: 300000. */
  paymentTimeoutMs?: number
  /** Whitelist of permitted request paths. Omit to allow all. */
  allowedPaths?: string[]
  /** Max request body size in bytes. Default: 65536. */
  maxBodyBytes?: number
  /** Max upstream response size in bytes. Default: 1048576 (1 MB). */
  maxResponseBytes?: number
  /** SOCKS5 proxy URL (stub — not yet implemented). */
  proxy?: string
}

/** Handle returned by `serve()` for graceful shutdown. */
export interface DvmHandle {
  /** @internal prevents GC of key material before close() is called. */
  _sentinel: object
  /** Stop the relay loop, cancel pending jobs, and zeroises the secret key. */
  close(): Promise<void>
}

/** Result of a successful `announce()` call. */
export interface Announcement {
  /** Nostr event ID of the published kind 31990 event. */
  eventId: string
  /** Relays the event was published to. */
  relays: string[]
}
