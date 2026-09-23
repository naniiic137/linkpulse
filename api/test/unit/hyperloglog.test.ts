import { describe, expect, it } from 'vitest';
import { HyperLogLog } from '../../src/lib/hyperloglog.js';

describe('HyperLogLog', () => {
  it('is exact-ish for small cardinalities (linear counting range)', () => {
    const h = new HyperLogLog();
    for (let i = 0; i < 100; i++) h.add(`v${i}`);
    expect(h.count()).toBeGreaterThanOrEqual(99);
    expect(h.count()).toBeLessThanOrEqual(101);
  });

  it('ignores duplicates', () => {
    const h = new HyperLogLog();
    for (let r = 0; r < 5; r++) for (let i = 0; i < 1000; i++) h.add(`visitor-${i}`);
    expect(Math.abs(h.count() - 1000)).toBeLessThanOrEqual(15);
  });

  it('stays within 2% at 200k distinct items using 16 KB', () => {
    const h = new HyperLogLog(14);
    const n = 200_000;
    for (let i = 0; i < n; i++) h.add(`id-${i}`);
    expect(h.registers.byteLength).toBe(16_384);
    expect(Math.abs(h.count() - n) / n).toBeLessThan(0.02);
  });

  it('merge equals the union (like PFCOUNT over several keys)', () => {
    const monday = new HyperLogLog();
    const tuesday = new HyperLogLog();
    for (let i = 0; i < 5000; i++) monday.add(`u${i}`);
    for (let i = 2500; i < 7500; i++) tuesday.add(`u${i}`);
    const union = HyperLogLog.union([monday, tuesday]).count();
    expect(Math.abs(union - 7500) / 7500).toBeLessThan(0.03);
  });

  it('add() reports whether registers changed', () => {
    const h = new HyperLogLog();
    expect(h.add('x')).toBe(true);
    expect(h.add('x')).toBe(false);
  });
});
