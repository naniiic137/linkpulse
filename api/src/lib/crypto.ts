import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { BASE62_ALPHABET } from './base62.js';

/**
 * Passwords (account and link passwords) use Argon2id, the OWASP-recommended
 * memory-hard KDF. Parameters follow OWASP's minimum (19 MiB, t=2, p=1);
 * tests use cheaper parameters through `setHashCost('fast')`.
 */
let cost = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function setHashCost(level: 'default' | 'fast'): void {
  cost = level === 'fast' ? { memoryCost: 1024, timeCost: 1, parallelism: 1 } : { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
}

export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, cost);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * API keys are 190+ bits of randomness, so a single fast SHA-256 is enough to
 * store them safely (a slow KDF protects *low-entropy* secrets like passwords;
 * it would only add latency to every API call here) and allows an indexed lookup.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomBase62(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 248) out += BASE62_ALPHABET[b % 62]; // 248 = 62*4: rejection sampling avoids modulo bias
  }
  return out.length === length ? out : out + randomBase62(length - out.length);
}

export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = `lp_live_${randomBase62(32)}`;
  return { secret, prefix: secret.slice(0, 12), hash: sha256Hex(secret) };
}

/**
 * Privacy-preserving visitor id: HMAC(salt, ip + user agent). Raw IPs are never
 * queued or stored; the salt keeps hashes from being reversed by brute-forcing
 * the IPv4 space.
 */
export function visitorHash(salt: string, ip: string, userAgent: string): string {
  return createHmac('sha256', salt).update(ip).update('\0').update(userAgent).digest('hex').slice(0, 32);
}
