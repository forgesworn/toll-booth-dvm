import type { BoothConfigLike, AnnounceOptions, PriceInfo } from './types.js'
import { slugify } from './slugify.js'
import { JOB_KIND } from './constants.js'

interface PricingEntry {
  capability: string
  price: number
  currency: string
}

export interface MappedConfig {
  identifier: string
  content: {
    name: string
    about: string
    pricing: PricingEntry[]
    urls: string[]
    paymentMethods: string[]
    picture?: string
    version?: string
  }
  tags: string[][]
}

export function mapBoothConfig(
  boothConfig: BoothConfigLike,
  options: AnnounceOptions,
): MappedConfig {
  const name = boothConfig.serviceName ?? 'toll-booth-dvm'
  const identifier = options.identifier ?? slugify(name)

  const pricing: PricingEntry[] = []
  for (const [capability, entry] of Object.entries(boothConfig.pricing)) {
    if (typeof entry === 'number') {
      pricing.push({ capability, price: entry, currency: 'sats' })
    } else if (isPriceInfo(entry)) {
      if (entry.sats !== undefined) pricing.push({ capability, price: entry.sats, currency: 'sats' })
      if (entry.usd !== undefined) pricing.push({ capability, price: entry.usd, currency: 'usd' })
    } else {
      const defaultPrice = entry['default']
      if (defaultPrice !== undefined) {
        if (typeof defaultPrice === 'number') {
          pricing.push({ capability, price: defaultPrice, currency: 'sats' })
        } else if (isPriceInfo(defaultPrice)) {
          if (defaultPrice.sats !== undefined) pricing.push({ capability, price: defaultPrice.sats, currency: 'sats' })
          if (defaultPrice.usd !== undefined) pricing.push({ capability, price: defaultPrice.usd, currency: 'usd' })
        }
      }
    }
  }

  const paymentMethods: string[] = []
  if (boothConfig.hasBackend !== false) paymentMethods.push('lightning')
  if (boothConfig.ietfPayment) paymentMethods.push('payment')
  if (boothConfig.xcashu) paymentMethods.push('cashu')
  if (paymentMethods.length === 0) paymentMethods.push('lightning')

  const tags: string[][] = [
    ['d', identifier],
    ['k', String(JOB_KIND)],
  ]
  if (options.topics) {
    for (const topic of options.topics) {
      tags.push(['t', topic])
    }
  }

  return {
    identifier,
    content: {
      name,
      about: options.about,
      pricing,
      urls: options.urls,
      paymentMethods,
      ...(options.picture && { picture: options.picture }),
      ...(options.version && { version: options.version }),
    },
    tags,
  }
}

/**
 * Map a toll-booth config to a kind 31402 paid service announcement.
 * Tags carry all discovery-relevant metadata for relay-side filtering.
 */
export interface MappedPaidService {
  tags: string[][]
  content: string
}

export function mapPaidServices(
  boothConfig: BoothConfigLike,
  options: AnnounceOptions,
): MappedPaidService {
  const mapped = mapBoothConfig(boothConfig, options)
  const name = boothConfig.serviceName ?? 'toll-booth-dvm'
  const identifier = options.identifier ?? slugify(name)

  const tags: string[][] = [
    ['d', identifier],
    ['name', name],
    ['alt', `Paid API: ${name}`],
  ]

  for (const url of options.urls) {
    tags.push(['url', url])
  }

  tags.push(['summary', options.about])

  // Payment method identifier tags
  for (const method of mapped.content.paymentMethods) {
    if (method === 'lightning') tags.push(['pmi', 'l402', 'lightning'])
    else if (method === 'cashu') tags.push(['pmi', 'xcashu'])
    else if (method === 'payment') tags.push(['pmi', 'l402', 'lightning'])
  }

  // Per-capability pricing tags
  for (const entry of mapped.content.pricing) {
    tags.push(['price', entry.capability, String(entry.price), entry.currency])
  }

  if (options.topics) {
    for (const topic of options.topics) {
      tags.push(['t', topic])
    }
  }

  if (options.picture) tags.push(['picture', options.picture])

  // Content: capabilities array for programmatic consumers
  const capabilities = mapped.content.pricing.map((entry) => ({
    name: entry.capability,
    description: `${entry.capability} endpoint`,
    endpoint: entry.capability,
  }))

  const content = JSON.stringify({
    capabilities,
    ...(options.version && { version: options.version }),
  })

  return { tags, content }
}

function isPriceInfo(value: unknown): value is PriceInfo {
  return typeof value === 'object' && value !== null && ('sats' in value || 'usd' in value)
}
