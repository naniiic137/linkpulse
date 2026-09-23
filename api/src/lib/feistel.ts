import { createHash } from 'node:crypto';

/**
 * A keyed pseudo-random permutation over the integer domain [0, domainSize).
 *
 * Why: sequential ids are collision-free but make short codes enumerable
 * (`/abc0001`, `/abc0002`, ...). Passing the id through a bijection keeps the
 * "collision-free by construction" property of a counter while making codes
 * look random. It is obfuscation, not encryption: codes are not secrets.
 *
 * How: a balanced Feistel network over 2*halfBits bits is always a bijection
 * (whatever the round function), and "cycle walking" (re-applying it until the
 * value falls back inside the domain) restricts it to [0, domainSize) while
 * remaining a bijection there.
 */
export class FeistelPermutation {
  private readonly halfBits: number;
  private readonly halfMask: number;
  private readonly halfSize: number;
  private readonly keys: number[];

  constructor(
    readonly domainSize: number,
    secret: string,
    private readonly rounds = 4,
  ) {
    if (!Number.isSafeInteger(domainSize) || domainSize < 2) throw new RangeError('domainSize must be >= 2');
    const bits = Math.ceil(Math.log2(domainSize));
    this.halfBits = Math.max(1, Math.ceil(bits / 2));
    if (this.halfBits > 26) throw new RangeError('domain too large (max 52 bits)');
    this.halfSize = 2 ** this.halfBits;
    this.halfMask = this.halfSize - 1;
    const digest = createHash('sha256').update(secret).digest();
    this.keys = Array.from({ length: rounds }, (_, i) => digest.readUInt32LE((i * 4) % 28));
  }

  /** 32-bit integer mixing (murmur3 finalizer) keyed per round. */
  private round(value: number, i: number): number {
    let h = (value ^ this.keys[i]!) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h & this.halfMask;
  }

  private encryptOnce(x: number): number {
    let left = Math.floor(x / this.halfSize);
    let right = x % this.halfSize;
    for (let i = 0; i < this.rounds; i++) {
      const next = (left ^ this.round(right, i)) & this.halfMask;
      left = right;
      right = next;
    }
    return left * this.halfSize + right;
  }

  private decryptOnce(x: number): number {
    let left = Math.floor(x / this.halfSize);
    let right = x % this.halfSize;
    for (let i = this.rounds - 1; i >= 0; i--) {
      const prev = (right ^ this.round(left, i)) & this.halfMask;
      right = left;
      left = prev;
    }
    return left * this.halfSize + right;
  }

  encrypt(x: number): number {
    this.assertInDomain(x);
    let y = this.encryptOnce(x);
    while (y >= this.domainSize) y = this.encryptOnce(y);
    return y;
  }

  decrypt(y: number): number {
    this.assertInDomain(y);
    let x = this.decryptOnce(y);
    while (x >= this.domainSize) x = this.decryptOnce(x);
    return x;
  }

  private assertInDomain(x: number): void {
    if (!Number.isSafeInteger(x) || x < 0 || x >= this.domainSize) {
      throw new RangeError(`value ${x} outside permutation domain [0, ${this.domainSize})`);
    }
  }
}
