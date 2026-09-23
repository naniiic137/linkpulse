import type {
  ApiKeyRecord,
  Bucket,
  ClickAggregate,
  ClickRecord,
  LinkPatch,
  LinkRecord,
  OwnerAggregate,
  RawClick,
  TimeRange,
  User,
} from '../domain/types.js';
import type { RateDecision } from '../lib/slidingWindow.js';

/**
 * Source of truth (PostgreSQL in production, a Map-backed store locally).
 * Everything durable lives here; the "hot" interfaces below are caches,
 * counters and queues that can be rebuilt or tolerate loss.
 */
export interface Store {
  // users
  createUser(user: User): Promise<void>; // throws UniqueViolation('email')
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;

  // api keys
  createApiKey(key: ApiKeyRecord): Promise<void>;
  listApiKeys(userId: string): Promise<ApiKeyRecord[]>;
  findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>;
  deleteApiKey(userId: string, id: string): Promise<boolean>;
  touchApiKey(id: string, at: Date): Promise<void>;

  // links
  /** Lease the next block number for the short-code generator (atomic across instances). */
  nextIdBlock(): Promise<number>;
  insertLink(link: LinkRecord): Promise<void>; // throws UniqueViolation('code')
  findLinkById(id: string): Promise<LinkRecord | null>;
  findLinkByCode(code: string): Promise<LinkRecord | null>;
  listLinks(ownerId: string, opts: { limit: number; cursor?: { createdAt: Date; id: string }; q?: string }): Promise<LinkRecord[]>;
  countLinks(ownerId: string, now: Date): Promise<{ total: number; active: number }>;
  updateLink(id: string, patch: LinkPatch, now: Date): Promise<LinkRecord | null>;
  deleteLink(id: string): Promise<boolean>;

  // analytics
  /** Idempotent on click id (at-least-once queues may redeliver). Also bumps links.click_count for human clicks. */
  insertClicks(clicks: ClickRecord[]): Promise<number>;
  aggregateClicks(linkId: string, range: TimeRange, bucket: Bucket): Promise<ClickAggregate>;
  aggregateOwner(ownerId: string, range: TimeRange, topN: number): Promise<OwnerAggregate>;
  exportClicks(linkId: string, range: TimeRange, limit: number): Promise<ClickRecord[]>;

  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Key/value cache with TTL (Redis GET/SET EX/DEL). Used for cache-aside link lookups. */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
}

export interface RateLimiter {
  /** Count one request against `key` if it fits in the sliding window. */
  hit(key: string, limit: number, windowMs: number, now?: number): Promise<RateDecision>;
}

/** Durable-ish queue between the redirect path and the analytics writer. */
export interface ClickQueue {
  /** Fire-and-forget: never awaited by the redirect handler. */
  enqueue(click: RawClick): void;
  /** Take up to `max` events. Call `ack` after they are persisted. */
  take(max: number): Promise<{ clicks: RawClick[]; ack: () => Promise<void> }>;
  depth(): Promise<number>;
}

/** Approximate distinct counting (Redis PFADD / PFCOUNT). */
export interface UniqueCounter {
  add(entries: { key: string; member: string }[], ttlSeconds: number): Promise<void>;
  /** Cardinality of the union of the given counters. */
  count(keys: string[]): Promise<number>;
}

/** Atomic "consume one unit if under max" counter for max-clicks links. */
export interface QuotaCounter {
  /** Returns false when the quota is already exhausted. `seed` supplies the persisted count on a cold key. */
  consume(key: string, max: number, seed: () => Promise<number>): Promise<boolean>;
  reset(key: string): Promise<void>;
}

export interface LiveEvent {
  linkId: string;
  clicks: number;
  at: string;
}

/** Fan-out of "new clicks" notifications to SSE subscribers (Redis pub/sub across instances). */
export interface EventBus {
  publish(event: LiveEvent): void;
  subscribe(linkId: string, listener: (event: LiveEvent) => void): () => void;
}

export interface Infrastructure {
  kind: 'memory' | 'postgres+redis';
  store: Store;
  cache: Cache;
  rateLimiter: RateLimiter;
  queue: ClickQueue;
  uniques: UniqueCounter;
  quota: QuotaCounter;
  bus: EventBus;
  /** Liveness of the hot layer (Redis PING); resolves for the memory backend. */
  pingHot(): Promise<void>;
  close(): Promise<void>;
}
