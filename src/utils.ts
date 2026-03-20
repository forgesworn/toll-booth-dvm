export const HEX_64_RE = /^[0-9a-f]{64}$/

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function validateSecretKey(secretKey: string): void {
  if (!HEX_64_RE.test(secretKey)) {
    throw new Error('secretKey must be 64 hex characters')
  }
}
