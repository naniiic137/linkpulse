/** Core domain records. Stores persist these; routes map them to public DTOs. */

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  /** First characters of the secret, safe to display ("lp_live_3fK9"). */
  prefix: string;
  /** SHA-256 of the full secret. The secret itself is never stored. */
  keyHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface LinkRecord {
  /** Numeric id (as a decimal string so it survives JSON and bigint columns). */
  id: string;
  code: string;
  ownerId: string;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  isCustom: boolean;
  passwordHash: string | null;
  expiresAt: Date | null;
  maxClicks: number | null;
  disabled: boolean;
  publicStats: boolean;
  /** Human (non-bot) clicks persisted so far. Eventually consistent (flush interval). */
  clickCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type LinkStatus = 'active' | 'expired' | 'disabled' | 'limit_reached';

export interface LinkPatch {
  url?: string;
  title?: string | null;
  faviconUrl?: string | null;
  passwordHash?: string | null;
  expiresAt?: Date | null;
  maxClicks?: number | null;
  disabled?: boolean;
  publicStats?: boolean;
}

/**
 * What the redirect hot path needs, and nothing more. This is what gets cached
 * in Redis, so it deliberately excludes the password hash and analytics fields.
 */
export interface RedirectEntry {
  id: string;
  ownerId: string;
  url: string;
  hasPassword: boolean;
  expiresAt: number | null;
  maxClicks: number | null;
  disabled: boolean;
}

/** Raw click captured on the redirect path (cheap to build, no UA parsing). */
export interface RawClick {
  id: string;
  linkId: string;
  ownerId: string;
  ts: number;
  visitorHash: string;
  userAgent: string;
  referrer: string | null;
  country: string | null;
  isBot: boolean;
}

/** Click after enrichment by the analytics flusher; this is what gets persisted. */
export interface ClickRecord {
  id: string;
  linkId: string;
  ts: Date;
  visitorHash: string;
  referrer: string;
  country: string;
  device: string;
  browser: string;
  os: string;
  isBot: boolean;
}

export type Bucket = 'hour' | 'day';

export interface NamedCount {
  name: string;
  clicks: number;
}

export interface ClickAggregate {
  clicks: number;
  bots: number;
  series: { t: Date; clicks: number }[];
  referrers: NamedCount[];
  countries: NamedCount[];
  browsers: NamedCount[];
  os: NamedCount[];
  devices: NamedCount[];
}

export interface OwnerAggregate {
  clicks: number;
  series: { t: Date; clicks: number }[];
  topLinks: { linkId: string; clicks: number }[];
}

export interface TimeRange {
  from: Date;
  to: Date;
}
