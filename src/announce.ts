import type { BoothConfigLike, AnnounceOptions, Announcement } from './types.js'

export async function announce(
  _boothConfig: BoothConfigLike,
  _options: AnnounceOptions,
): Promise<Announcement> {
  throw new Error('Not implemented')
}
