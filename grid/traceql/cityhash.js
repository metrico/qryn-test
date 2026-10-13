// ClickHouse's cityHash64 (CityHash v1.0.2) of 4 to 16 bytes, which covers
// the 8-byte span ids and 16-byte trace ids the grid samples by.

const MASK = (1n << 64n) - 1n
const K_MUL = 0x9ddfea08eb382d69n

const fetch = (bytes, at, n) => {
  let v = 0n
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i])
  return v
}

const hashLen16 = (u, v) => {
  let a = ((u ^ v) * K_MUL) & MASK
  a ^= a >> 47n
  let b = ((v ^ a) * K_MUL) & MASK
  b ^= b >> 47n
  return (b * K_MUL) & MASK
}

const rotate = (v, shift) => ((v >> shift) | (v << (64n - shift))) & MASK

/**
 * cityHash64 hashes the bytes of a hex string of 4 to 16 bytes, as a BigInt.
 * @param hex {string}
 */
const cityHash64 = (hex) => {
  const bytes = Buffer.from(hex, 'hex')
  const len = bytes.length
  if (len > 16 || len < 4) throw new Error(`cityHash64: ${len} bytes`)
  if (len > 8) {
    const a = fetch(bytes, 0, 8)
    const b = fetch(bytes, len - 8, 8)
    return hashLen16(a, rotate((b + BigInt(len)) & MASK, BigInt(len))) ^ b
  }
  const a = fetch(bytes, 0, 4)
  return hashLen16((BigInt(len) + (a << 3n)) & MASK, fetch(bytes, len - 4, 4))
}

/**
 * sampleThreshold is fraction·2^64 truncated, the hash bound of a sample.
 * @param fraction {number} in (0, 1)
 */
const sampleThreshold = (fraction) => BigInt(Math.trunc(fraction * 2 ** 64))

module.exports = { cityHash64, sampleThreshold }
