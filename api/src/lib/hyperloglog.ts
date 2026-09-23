import { createHash } from 'node:crypto';

/**
 * A HyperLogLog cardinality estimator, used by the in-memory backend so it
 * behaves like Redis PFADD/PFCOUNT (same precision: 2^14 registers, ~0.81%
 * standard error, 16 KB per counter regardless of how many visitors it sees).
 *
 * Each item is hashed to 64 bits. The first `p` bits pick a register; the
 * register keeps the maximum "rank" (position of the first 1-bit) seen in the
 * remaining bits. Many distinct items => some rare long runs of zeros => high
 * ranks. The harmonic mean of 2^-rank across registers estimates cardinality.
 */
export class HyperLogLog {
  readonly registers: Uint8Array;
  private readonly m: number;

  constructor(readonly precision = 14) {
    if (precision < 4 || precision > 16) throw new RangeError('precision must be in [4, 16]');
    this.m = 1 << precision;
    this.registers = new Uint8Array(this.m);
  }

  /** Adds an item. Returns true if any register changed (like PFADD's return value). */
  add(item: string): boolean {
    const h = createHash('md5').update(item).digest();
    const hi = h.readUInt32BE(0);
    const lo = h.readUInt32BE(4);
    const index = hi >>> (32 - this.precision);
    // Remaining (64 - p) bits: low bits of `hi` followed by `lo`.
    const hiRest = (hi << this.precision) >>> 0;
    const restBits = 64 - this.precision;
    let rank: number;
    if (hiRest !== 0) {
      rank = Math.clz32(hiRest) + 1;
    } else {
      rank = 32 - this.precision + (lo === 0 ? 32 : Math.clz32(lo)) + 1;
    }
    rank = Math.min(rank, restBits + 1);
    if (rank > this.registers[index]!) {
      this.registers[index] = rank;
      return true;
    }
    return false;
  }

  /** Merge another HLL of the same precision into this one (register-wise max). */
  merge(other: HyperLogLog): this {
    if (other.precision !== this.precision) throw new Error('precision mismatch');
    for (let i = 0; i < this.m; i++) {
      if (other.registers[i]! > this.registers[i]!) this.registers[i] = other.registers[i]!;
    }
    return this;
  }

  count(): number {
    const m = this.m;
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < m; i++) {
      const r = this.registers[i]!;
      sum += 2 ** -r;
      if (r === 0) zeros++;
    }
    const alpha = 0.7213 / (1 + 1.079 / m);
    const estimate = (alpha * m * m) / sum;
    // Small-range correction: linear counting is far more accurate while many registers are empty.
    if (estimate <= 2.5 * m && zeros > 0) return Math.round(m * Math.log(m / zeros));
    return Math.round(estimate);
  }

  static union(items: HyperLogLog[], precision = 14): HyperLogLog {
    const out = new HyperLogLog(precision);
    for (const h of items) out.merge(h);
    return out;
  }
}
