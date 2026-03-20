export interface PriceInfo {
  sats?: number
  usd?: number
}

export interface BoothConfigLike {
  pricing: Record<string, number | PriceInfo | Record<string, number | PriceInfo>>
  serviceName?: string
  hasBackend?: boolean
  xcashu?: { mints: string[] }
}

export interface AnnounceOptions {
  secretKey: string
  relays: string[]
  urls: string[]
  about: string
  topics?: string[]
  identifier?: string
  picture?: string
  version?: string
}

export interface ServeOptions {
  secretKey: string
  relays: string[]
  endpoint: string
  about?: string
  announceOnStart?: boolean
  boothConfig?: BoothConfigLike
  pollIntervalMs?: number
  maxPendingJobs?: number
  requestTimeoutMs?: number
  paymentTimeoutMs?: number
  allowedPaths?: string[]
  maxBodyBytes?: number
  proxy?: string
}

export interface DvmHandle {
  close(): Promise<void>
}

export interface Announcement {
  eventId: string
  relays: string[]
}
