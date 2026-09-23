import type { ClickRecord, RawClick } from '../domain/types.js';
import { dayKey } from '../lib/time.js';
import { parseAgent, referrerHost, type ParsedAgent } from '../lib/userAgent.js';
import type { ClickQueue, EventBus, Store, UniqueCounter } from '../stores/types.js';

export const UNIQUE_TTL_SECONDS = 400 * 86_400;
/** Hash tags `{...}` keep every counter of one link (or owner) in the same Redis Cluster slot, so PFCOUNT over many days works. */
export const linkUniqueKey = (linkId: string, day: string) => `lp:uniq:{L${linkId}}:${day}`;
export const ownerUniqueKey = (ownerId: string, day: string) => `lp:uniq:{O${ownerId}}:${day}`;

/**
 * Background writer: drains the click queue in batches, enriches events
 * (user-agent parsing, referrer normalisation) and persists them with one
 * multi-row insert per batch, then updates HyperLogLog unique counters and
 * notifies live (SSE) subscribers.
 */
export class ClickPipeline {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private readonly uaCache = new Map<string, ParsedAgent>();
  stats = { flushed: 0, batches: 0, failures: 0 };

  constructor(
    private readonly d: {
      queue: ClickQueue;
      store: Store;
      uniques: UniqueCounter;
      bus: EventBus;
      batchSize: number;
      intervalMs: number;
      log?: { error: (obj: unknown, msg: string) => void };
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch((err) => this.d.log?.error({ err }, 'analytics flush failed'));
    }, this.d.intervalMs);
    this.timer.unref();
  }

  /** Stop the timer and drain what is left (graceful shutdown). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
    await this.flush();
  }

  /** Drain the queue completely. Concurrent calls share the in-flight run. */
  flush(): Promise<number> {
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 1000; i++) {
      const { clicks, ack } = await this.d.queue.take(this.d.batchSize);
      if (clicks.length === 0) {
        await ack();
        break;
      }
      await this.persist(clicks);
      await ack();
      total += clicks.length;
      if (clicks.length < this.d.batchSize) break;
    }
    return total;
  }

  private agent(ua: string): ParsedAgent {
    let parsed = this.uaCache.get(ua);
    if (!parsed) {
      parsed = parseAgent(ua);
      if (this.uaCache.size > 5000) this.uaCache.clear();
      this.uaCache.set(ua, parsed);
    }
    return parsed;
  }

  enrich(raw: RawClick): ClickRecord {
    const agent = this.agent(raw.userAgent);
    return {
      id: raw.id,
      linkId: raw.linkId,
      ts: new Date(raw.ts),
      visitorHash: raw.visitorHash,
      referrer: referrerHost(raw.referrer),
      country: raw.country ?? 'Unknown',
      device: raw.isBot ? 'bot' : agent.device,
      browser: agent.browser,
      os: agent.os,
      isBot: raw.isBot,
    };
  }

  private async persist(raw: RawClick[]): Promise<void> {
    const records = raw.map((r) => this.enrich(r));
    try {
      await this.d.store.insertClicks(records);
    } catch (err) {
      // One bad row (e.g. its link was deleted mid-flight) must not poison the batch forever:
      // fall back to row-by-row and drop what still fails.
      this.stats.failures++;
      this.d.log?.error({ err, size: records.length }, 'batch insert failed, retrying row by row');
      let ok = 0;
      for (const rec of records) {
        await this.d.store
          .insertClicks([rec])
          .then(() => ok++)
          .catch(() => {});
      }
      // Nothing worked: the database is probably down. Throw so the batch is not acked
      // (Redis keeps it pending and XAUTOCLAIM redelivers it later).
      if (ok === 0) throw err;
    }
    this.stats.batches++;
    this.stats.flushed += records.length;

    const humans = raw.filter((r) => !r.isBot);
    const perDay = humans.map((r) => ({ r, day: dayKey(r.ts) }));
    await this.d.uniques.add(
      perDay.flatMap(({ r, day }) => [
        { key: linkUniqueKey(r.linkId, day), member: r.visitorHash },
        { key: ownerUniqueKey(r.ownerId, day), member: r.visitorHash },
      ]),
      UNIQUE_TTL_SECONDS,
    );
    await this.d.uniques.add(
      humans.map((r) => ({ key: linkUniqueKey(r.linkId, 'all'), member: r.visitorHash })),
      10 * 365 * 86_400,
    );

    const perLink = new Map<string, number>();
    for (const r of humans) perLink.set(r.linkId, (perLink.get(r.linkId) ?? 0) + 1);
    const at = new Date().toISOString();
    for (const [linkId, clicks] of perLink) this.d.bus.publish({ linkId, clicks, at });
  }
}
