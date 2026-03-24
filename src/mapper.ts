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

function isPriceInfo(value: unknown): value is PriceInfo {
  return typeof value === 'object' && value !== null && ('sats' in value || 'usd' in value)
}
