import { encodeBase62 } from './base62.js';
import { FeistelPermutation } from './feistel.js';

export const CODE_LENGTH = 7;
/** 62^7 ≈ 3.5 trillion possible codes. */
export const CODE_SPACE = 62 ** CODE_LENGTH;

/**
 * Short-code generator: counter + range leasing + keyed permutation.
 *
 * 1. Ids come from a global counter, but an instance leases a *block* of ids
 *    (`blockSize` at a time) from the source of truth (a PostgreSQL sequence),
 *    so the database is hit once per 1000 links rather than once per link and
 *    many API instances never hand out the same id.
 * 2. Each id is mapped through a Feistel permutation of [0, 62^7) and base62
 *    encoded to exactly 7 characters. A permutation is a bijection, so two
 *    different ids can never produce the same code: no "generate, check,
 *    retry" loop and no birthday-paradox collisions as the table grows.
 *
 * The only possible collision is with a user-chosen custom alias that happens
 * to be 7 characters long; the store's unique constraint catches that and the
 * link service simply takes the next id.
 */
export class CodeGenerator {
  private next = 0;
  private end = 0;
  private leasing: Promise<void> | null = null;
  private readonly permutation: FeistelPermutation;

  constructor(
    private readonly leaseBlock: () => Promise<number>,
    secret: string,
    readonly blockSize = 1000,
  ) {
    this.permutation = new FeistelPermutation(CODE_SPACE, secret);
  }

  /** Returns a fresh numeric id. Concurrent callers share one in-flight lease. */
  async nextId(): Promise<number> {
    while (this.next >= this.end) {
      if (!this.leasing) {
        this.leasing = this.leaseBlock()
          .then((block) => {
            const start = block * this.blockSize;
            if (start + this.blockSize > CODE_SPACE) throw new Error('Short-code space exhausted');
            this.next = start;
            this.end = start + this.blockSize;
          })
          .finally(() => {
            this.leasing = null;
          });
      }
      await this.leasing;
    }
    return this.next++;
  }

  codeFor(id: number): string {
    return encodeBase62(this.permutation.encrypt(id), CODE_LENGTH);
  }

  /** Allocate an id and its code in one step. */
  async generate(): Promise<{ id: number; code: string }> {
    const id = await this.nextId();
    return { id, code: this.codeFor(id) };
  }
}
