import { describe, expect, it, vi } from 'vitest';
import { BASE62_ALPHABET, decodeBase62, encodeBase62 } from '../../src/lib/base62.js';
import { CODE_LENGTH, CODE_SPACE, CodeGenerator } from '../../src/lib/codeGenerator.js';
import { FeistelPermutation } from '../../src/lib/feistel.js';

describe('base62', () => {
  it('uses exactly 62 distinct URL-safe characters', () => {
    expect(BASE62_ALPHABET).toHaveLength(62);
    expect(new Set(BASE62_ALPHABET).size).toBe(62);
    expect(BASE62_ALPHABET).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('round-trips and pads', () => {
    for (const n of [0, 1, 61, 62, 3843, 3844, 916_132_831, CODE_SPACE - 1]) {
      expect(decodeBase62(encodeBase62(n))).toBe(n);
    }
    expect(encodeBase62(0, 7)).toBe('0000000');
    expect(encodeBase62(CODE_SPACE - 1)).toBe('zzzzzzz');
  });

  it('rejects invalid input', () => {
    expect(() => encodeBase62(-1)).toThrow(RangeError);
    expect(() => encodeBase62(1.5)).toThrow(RangeError);
    expect(() => decodeBase62('ab-c')).toThrow(RangeError);
  });
});

describe('FeistelPermutation', () => {
  it('is a bijection on a non-power-of-two domain (exhaustive, 62^3 values)', () => {
    const size = 62 ** 3;
    const p = new FeistelPermutation(size, 'test-secret');
    const seen = new Uint8Array(size);
    for (let x = 0; x < size; x++) {
      const y = p.encrypt(x);
      if (y < 0 || y >= size) throw new Error(`${x} mapped outside the domain: ${y}`);
      if (seen[y]) throw new Error(`collision at ${x} -> ${y}`);
      seen[y] = 1;
    }
    expect(seen.every((v) => v === 1)).toBe(true);
  });

  it('decrypt inverts encrypt on the full 62^7 domain', () => {
    const p = new FeistelPermutation(CODE_SPACE, 'secret');
    for (const x of [0, 1, 2, 999, 1_000_000, 123_456_789_012, CODE_SPACE - 1]) {
      expect(p.decrypt(p.encrypt(x))).toBe(x);
    }
  });

  it('scatters sequential ids and depends on the secret', () => {
    const a = new FeistelPermutation(CODE_SPACE, 'secret-a');
    const b = new FeistelPermutation(CODE_SPACE, 'secret-b');
    const outs = [1000, 1001, 1002].map((x) => a.encrypt(x));
    expect(Math.abs(outs[1]! - outs[0]!)).toBeGreaterThan(1000);
    expect(a.encrypt(1000)).not.toBe(b.encrypt(1000));
  });

  it('rejects values outside the domain', () => {
    const p = new FeistelPermutation(100, 's');
    expect(() => p.encrypt(100)).toThrow(RangeError);
    expect(() => p.encrypt(-1)).toThrow(RangeError);
  });
});

describe('CodeGenerator', () => {
  it('produces 100k unique 7-character base62 codes', async () => {
    let block = 0;
    const gen = new CodeGenerator(async () => ++block, 'secret');
    const codes = new Set<string>();
    for (let i = 0; i < 100_000; i++) {
      const { code } = await gen.generate();
      if (code.length !== CODE_LENGTH) throw new Error(`bad length: ${code}`);
      codes.add(code);
    }
    expect(codes.size).toBe(100_000);
    for (const code of [...codes].slice(0, 1000)) expect(code).toMatch(/^[0-9A-Za-z]{7}$/);
  });

  it('leases one block per 1000 ids, even under concurrency', async () => {
    let block = 0;
    const lease = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return ++block;
    });
    const gen = new CodeGenerator(lease, 'secret', 1000);
    const ids = await Promise.all(Array.from({ length: 2500 }, () => gen.nextId()));
    expect(new Set(ids).size).toBe(2500);
    expect(lease).toHaveBeenCalledTimes(3);
    expect(Math.min(...ids)).toBe(1000);
  });

  it('two instances sharing a sequence never hand out the same id', async () => {
    let block = 0;
    const lease = async () => ++block; // stands in for PostgreSQL nextval()
    const a = new CodeGenerator(lease, 'secret', 10);
    const b = new CodeGenerator(lease, 'secret', 10);
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      codes.add((await a.generate()).code);
      codes.add((await b.generate()).code);
    }
    expect(codes.size).toBe(400);
  });
});
