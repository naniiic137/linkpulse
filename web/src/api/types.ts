export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export type LinkStatus = 'active' | 'expired' | 'disabled' | 'limit_reached';

export interface Link {
  id: string;
  code: string;
  shortUrl: string;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  isCustom: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  maxClicks: number | null;
  disabled: boolean;
  publicStats: boolean;
  clickCount: number;
  status: LinkStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CreateLinkInput {
  url: string;
  alias?: string;
  expiresAt?: string;
  maxClicks?: number;
  password?: string;
  publicStats?: boolean;
}

export interface UpdateLinkInput {
  url?: string;
  disabled?: boolean;
  expiresAt?: string | null;
  maxClicks?: number | null;
  password?: string | null;
  publicStats?: boolean;
}

export type Bucket = 'hour' | 'day';

export interface NamedCount {
  name: string;
  clicks: number;
}

export interface TimePoint {
  t: string;
  clicks: number;
}

export interface Analytics {
  linkId: string;
  range: { from: string; to: string; bucket: Bucket };
  totals: { clicks: number; uniqueVisitors: number; bots: number };
  timeseries: TimePoint[];
  referrers: NamedCount[];
  countries: NamedCount[];
  browsers: NamedCount[];
  os: NamedCount[];
  devices: NamedCount[];
}

export interface Overview {
  totals: { links: number; activeLinks: number; clicks: number; uniqueVisitors: number };
  timeseries: TimePoint[];
  topLinks: { id: string; code: string; title: string | null; url: string; clicks: number }[];
}

export interface PublicStats {
  code: string;
  shortUrl: string;
  title: string | null;
  url: string;
  createdAt: string;
  analytics: Analytics;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ClickEvent {
  linkId: string;
  clicks: number;
  at: string;
}
