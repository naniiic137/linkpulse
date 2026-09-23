import pg from 'pg';
import { UniqueViolation } from '../../domain/errors.js';
import type {
  ApiKeyRecord,
  Bucket,
  ClickAggregate,
  ClickRecord,
  LinkPatch,
  LinkRecord,
  NamedCount,
  OwnerAggregate,
  TimeRange,
  User,
} from '../../domain/types.js';
import { bucketMs } from '../../lib/time.js';
import type { Store } from '../types.js';

interface LinkRow {
  id: string;
  code: string;
  owner_id: string;
  url: string;
  title: string | null;
  favicon_url: string | null;
  is_custom: boolean;
  password_hash: string | null;
  expires_at: Date | null;
  max_clicks: number | null;
  disabled: boolean;
  public_stats: boolean;
  click_count: string;
  created_at: Date;
  updated_at: Date;
}

const toLink = (r: LinkRow): LinkRecord => ({
  id: r.id,
  code: r.code,
  ownerId: r.owner_id,
  url: r.url,
  title: r.title,
  faviconUrl: r.favicon_url,
  isCustom: r.is_custom,
  passwordHash: r.password_hash,
  expiresAt: r.expires_at,
  maxClicks: r.max_clicks,
  disabled: r.disabled,
  publicStats: r.public_stats,
  clickCount: Number(r.click_count),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface KeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: Date;
  last_used_at: Date | null;
}

const toKey = (r: KeyRow): ApiKeyRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  prefix: r.prefix,
  keyHash: r.key_hash,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  passwordHash: r.password_hash,
  createdAt: r.created_at,
});

const PATCH_COLUMNS: Record<keyof LinkPatch, string> = {
  url: 'url',
  title: 'title',
  faviconUrl: 'favicon_url',
  passwordHash: 'password_hash',
  expiresAt: 'expires_at',
  maxClicks: 'max_clicks',
  disabled: 'disabled',
  publicStats: 'public_stats',
};

function uniqueField(err: unknown): string | null {
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return null;
  if (e.constraint?.includes('email')) return 'email';
  if (e.constraint?.includes('code')) return 'code';
  if (e.constraint?.includes('key_hash')) return 'key_hash';
  return e.constraint ?? 'unknown';
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const DIMENSIONS = ['referrer', 'country', 'browser', 'os', 'device'] as const;

export class PostgresStore implements Store {
  constructor(readonly pool: pg.Pool) {}

  static connect(databaseUrl: string): PostgresStore {
    return new PostgresStore(new pg.Pool({ connectionString: databaseUrl, max: 20, idleTimeoutMillis: 30_000 }));
  }

  async createUser(user: User): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
        [user.id, user.email, user.name, user.passwordHash, user.createdAt],
      );
    } catch (err) {
      const field = uniqueField(err);
      if (field) throw new UniqueViolation(field);
      throw err;
    }
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async findUserById(id: string): Promise<User | null> {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async createApiKey(key: ApiKeyRecord): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [key.id, key.userId, key.name, key.prefix, key.keyHash, key.createdAt],
      );
    } catch (err) {
      const field = uniqueField(err);
      if (field) throw new UniqueViolation(field);
      throw err;
    }
  }

  async listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    const r = await this.pool.query<KeyRow>('SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return r.rows.map(toKey);
  }

  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const r = await this.pool.query<KeyRow>('SELECT * FROM api_keys WHERE key_hash = $1', [hash]);
    return r.rows[0] ? toKey(r.rows[0]) : null;
  }

  async deleteApiKey(userId: string, id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2', [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async touchApiKey(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [id, at]);
  }

  async nextIdBlock(): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT nextval('link_id_block_seq') AS n");
    return Number(r.rows[0]!.n);
  }

  async insertLink(l: LinkRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO links (id, code, owner_id, url, title, favicon_url, is_custom, password_hash, expires_at,
           max_clicks, disabled, public_stats, click_count, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          l.id, l.code, l.ownerId, l.url, l.title, l.faviconUrl, l.isCustom, l.passwordHash, l.expiresAt,
          l.maxClicks, l.disabled, l.publicStats, l.clickCount, l.createdAt, l.updatedAt,
        ],
      );
    } catch (err) {
      const field = uniqueField(err);
      if (field) throw new UniqueViolation(field === 'links_pkey' ? 'id' : field);
      throw err;
    }
  }

  async findLinkById(id: string): Promise<LinkRecord | null> {
    if (!/^\d{1,18}$/.test(id)) return null;
    const r = await this.pool.query<LinkRow>('SELECT * FROM links WHERE id = $1', [id]);
    return r.rows[0] ? toLink(r.rows[0]) : null;
  }

  async findLinkByCode(code: string): Promise<LinkRecord | null> {
    const r = await this.pool.query<LinkRow>('SELECT * FROM links WHERE code = $1', [code]);
    return r.rows[0] ? toLink(r.rows[0]) : null;
  }

  async listLinks(
    ownerId: string,
    opts: { limit: number; cursor?: { createdAt: Date; id: string }; q?: string },
  ): Promise<LinkRecord[]> {
    const params: unknown[] = [ownerId];
    const where = ['owner_id = $1'];
    if (opts.cursor) {
      params.push(opts.cursor.createdAt, opts.cursor.id);
      where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
    }
    if (opts.q) {
      params.push(`%${escapeLike(opts.q)}%`);
      const p = `$${params.length}`;
      where.push(`(code ILIKE ${p} OR url ILIKE ${p} OR coalesce(title, '') ILIKE ${p})`);
    }
    params.push(opts.limit);
    const r = await this.pool.query<LinkRow>(
      `SELECT * FROM links WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toLink);
  }

  async countLinks(ownerId: string, now: Date): Promise<{ total: number; active: number }> {
    const r = await this.pool.query<{ total: string; active: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE NOT disabled
                                 AND (expires_at IS NULL OR expires_at > $2)
                                 AND (max_clicks IS NULL OR click_count < max_clicks)) AS active
         FROM links WHERE owner_id = $1`,
      [ownerId, now],
    );
    return { total: Number(r.rows[0]!.total), active: Number(r.rows[0]!.active) };
  }

  async updateLink(id: string, patch: LinkPatch, now: Date): Promise<LinkRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, value] of Object.entries(patch) as [keyof LinkPatch, unknown][]) {
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }
    params.push(now);
    sets.push(`updated_at = $${params.length}`);
    const r = await this.pool.query<LinkRow>(`UPDATE links SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return r.rows[0] ? toLink(r.rows[0]) : null;
  }

  async deleteLink(id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM links WHERE id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * One round trip per batch: unnest() the columns, insert with ON CONFLICT DO
   * NOTHING (idempotent redelivery), skip clicks whose link was deleted, and
   * bump links.click_count by the number of *newly inserted* human clicks.
   */
  async insertClicks(clicks: ClickRecord[]): Promise<number> {
    if (!clicks.length) return 0;
    const cols = {
      id: [] as string[], link: [] as string[], ts: [] as Date[], visitor: [] as string[], referrer: [] as string[],
      country: [] as string[], device: [] as string[], browser: [] as string[], os: [] as string[], bot: [] as boolean[],
    };
    for (const c of clicks) {
      cols.id.push(c.id); cols.link.push(c.linkId); cols.ts.push(c.ts); cols.visitor.push(c.visitorHash);
      cols.referrer.push(c.referrer); cols.country.push(c.country); cols.device.push(c.device);
      cols.browser.push(c.browser); cols.os.push(c.os); cols.bot.push(c.isBot);
    }
    const r = await this.pool.query<{ inserted: number }>(
      `WITH input AS (
         SELECT * FROM unnest($1::uuid[], $2::bigint[], $3::timestamptz[], $4::text[], $5::text[], $6::text[],
                              $7::text[], $8::text[], $9::text[], $10::boolean[])
           AS t(id, link_id, ts, visitor_hash, referrer, country, device, browser, os, is_bot)
       ), ins AS (
         INSERT INTO clicks (id, link_id, ts, visitor_hash, referrer, country, device, browser, os, is_bot)
         SELECT i.id, i.link_id, i.ts, i.visitor_hash, i.referrer, i.country, i.device, i.browser, i.os, i.is_bot
           FROM input i JOIN links l ON l.id = i.link_id
         ON CONFLICT (id) DO NOTHING
         RETURNING link_id, is_bot
       ), bump AS (
         UPDATE links SET click_count = links.click_count + c.n
           FROM (SELECT link_id, count(*) AS n FROM ins WHERE NOT is_bot GROUP BY link_id) c
          WHERE links.id = c.link_id
       )
       SELECT count(*)::int AS inserted FROM ins`,
      [cols.id, cols.link, cols.ts, cols.visitor, cols.referrer, cols.country, cols.device, cols.browser, cols.os, cols.bot],
    );
    return r.rows[0]?.inserted ?? 0;
  }

  async aggregateClicks(linkId: string, range: TimeRange, bucket: Bucket): Promise<ClickAggregate> {
    const size = bucketMs(bucket) / 1000;
    const args = [linkId, range.from, range.to];
    const [totals, series, dims] = await Promise.all([
      this.pool.query<{ clicks: number; bots: number }>(
        `SELECT count(*) FILTER (WHERE NOT is_bot)::int AS clicks, count(*) FILTER (WHERE is_bot)::int AS bots
           FROM clicks WHERE link_id = $1 AND ts >= $2 AND ts < $3`,
        args,
      ),
      this.pool.query<{ t: Date; clicks: number }>(
        `SELECT to_timestamp(floor(extract(epoch FROM ts) / $4) * $4) AS t, count(*)::int AS clicks
           FROM clicks WHERE link_id = $1 AND ts >= $2 AND ts < $3 AND NOT is_bot
          GROUP BY 1 ORDER BY 1`,
        [...args, size],
      ),
      // One scan for all five breakdowns.
      this.pool.query<Record<(typeof DIMENSIONS)[number], string | null> & { g: number; n: number }>(
        `SELECT referrer, country, browser, os, device,
                GROUPING(referrer, country, browser, os, device) AS g, count(*)::int AS n
           FROM clicks WHERE link_id = $1 AND ts >= $2 AND ts < $3 AND NOT is_bot
          GROUP BY GROUPING SETS ((referrer), (country), (browser), (os), (device))`,
        args,
      ),
    ]);
    const breakdown: Record<(typeof DIMENSIONS)[number], NamedCount[]> = {
      referrer: [], country: [], browser: [], os: [], device: [],
    };
    for (const row of dims.rows) {
      // GROUPING() sets a bit for every column NOT in the grouping set; the one clear bit is our dimension.
      const idx = DIMENSIONS.findIndex((_, i) => ((row.g >> (DIMENSIONS.length - 1 - i)) & 1) === 0);
      const dim = DIMENSIONS[idx];
      if (dim) breakdown[dim].push({ name: String(row[dim]), clicks: row.n });
    }
    const top = (list: NamedCount[]) =>
      list.sort((a, b) => b.clicks - a.clicks || a.name.localeCompare(b.name)).slice(0, 10);
    return {
      clicks: totals.rows[0]?.clicks ?? 0,
      bots: totals.rows[0]?.bots ?? 0,
      series: series.rows.map((r) => ({ t: r.t, clicks: r.clicks })),
      referrers: top(breakdown.referrer),
      countries: top(breakdown.country),
      browsers: top(breakdown.browser),
      os: top(breakdown.os),
      devices: top(breakdown.device),
    };
  }

  async aggregateOwner(ownerId: string, range: TimeRange, topN: number): Promise<OwnerAggregate> {
    const args = [ownerId, range.from, range.to];
    const [series, top] = await Promise.all([
      this.pool.query<{ t: Date; clicks: number }>(
        `SELECT to_timestamp(floor(extract(epoch FROM c.ts) / 86400) * 86400) AS t, count(*)::int AS clicks
           FROM clicks c JOIN links l ON l.id = c.link_id
          WHERE l.owner_id = $1 AND c.ts >= $2 AND c.ts < $3 AND NOT c.is_bot
          GROUP BY 1 ORDER BY 1`,
        args,
      ),
      this.pool.query<{ link_id: string; clicks: number }>(
        `SELECT c.link_id, count(*)::int AS clicks
           FROM clicks c JOIN links l ON l.id = c.link_id
          WHERE l.owner_id = $1 AND c.ts >= $2 AND c.ts < $3 AND NOT c.is_bot
          GROUP BY c.link_id ORDER BY clicks DESC LIMIT $4`,
        [...args, topN],
      ),
    ]);
    return {
      clicks: series.rows.reduce((s, r) => s + r.clicks, 0),
      series: series.rows.map((r) => ({ t: r.t, clicks: r.clicks })),
      topLinks: top.rows.map((r) => ({ linkId: String(r.link_id), clicks: r.clicks })),
    };
  }

  async exportClicks(linkId: string, range: TimeRange, limit: number): Promise<ClickRecord[]> {
    const r = await this.pool.query<{
      id: string; link_id: string; ts: Date; visitor_hash: string; referrer: string; country: string;
      device: string; browser: string; os: string; is_bot: boolean;
    }>(
      `SELECT * FROM clicks WHERE link_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts LIMIT $4`,
      [linkId, range.from, range.to, limit],
    );
    return r.rows.map((c) => ({
      id: c.id, linkId: String(c.link_id), ts: c.ts, visitorHash: c.visitor_hash, referrer: c.referrer,
      country: c.country, device: c.device, browser: c.browser, os: c.os, isBot: c.is_bot,
    }));
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
