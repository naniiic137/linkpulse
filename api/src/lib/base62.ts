export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Encode a non-negative safe integer as base62, left-padded to `minLength`. */
export function encodeBase62(value: number, minLength = 0): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`encodeBase62 expects a non-negative safe integer, got ${value}`);
  }
  let n = value;
  let out = '';
  do {
    out = BASE62_ALPHABET[n % 62] + out;
    n = Math.floor(n / 62);
  } while (n > 0);
  return out.padStart(minLength, BASE62_ALPHABET[0]);
}

export function decodeBase62(input: string): number {
  let n = 0;
  for (const ch of input) {
    const digit = BASE62_ALPHABET.indexOf(ch);
    if (digit < 0) throw new RangeError(`Invalid base62 character: ${ch}`);
    n = n * 62 + digit;
  }
  if (!Number.isSafeInteger(n)) throw new RangeError('Decoded value exceeds safe integer range');
  return n;
}
