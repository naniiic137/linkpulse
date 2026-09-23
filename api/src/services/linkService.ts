import { AppError, badRequest, conflict, notFound, UniqueViolation } from '../domain/errors.js';
import type { LinkPatch, LinkRecord, LinkStatus, RedirectEntry } from '../domain/types.js';
import type { CodeGenerator } from '../lib/codeGenerator.js';
import { hashPassword } from '../lib/crypto.js';
import { checkAlias, checkDestination, type UrlPolicy } from '../lib/urlSafety.js';
import type { Cache, QuotaCounter, Store } from '../stores/types.js';

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

export interface LinkDto {
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

export const linkCacheKey = (code: string) => `lp:link:${code}`;
export const quotaKey = (linkId: string) => `lp:quota:{${linkId}}`;

export function linkStatus(link: Pick<LinkRecord, 'disabled' | 'expiresAt' | 'maxClicks' | 'clickCount'>, now: Date): LinkStatus {
  if (link.disabled) return 'disabled';
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (link.maxClicks !== null && link.clickCount >= link.maxClicks) return 'limit_reached';
  return 'active';
}

export function toRedirectEntry(link: LinkRecord): RedirectEntry {
  return {
    id: link.id,
    ownerId: link.ownerId,
    url: link.url,
    hasPassword: link.passwordHash !== null,
    expiresAt: link.expiresAt?.getTime() ?? null,
    maxClicks: link.maxClicks,
    disabled: link.disabled,
  };
}

const MAX_CLICKS_LIMIT = 1_000_000_000;

function parseFutureDate(value: string, now: Date): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest('validation_error', 'expiresAt must be an ISO-8601 date');
  if (d.getTime() <= now.getTime()) throw badRequest('validation_error', 'expiresAt must be in the future');
  return d;
}

function checkMaxClicks(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > MAX_CLICKS_LIMIT) {
    throw badRequest('validation_error', `maxClicks must be an integer between 1 and ${MAX_CLICKS_LIMIT}`);
  }
  return n;
}

function checkLinkPassword(p: string): string {
  if (p.length < 4 || p.length > 128) throw badRequest('validation_error', 'Link password must be 4-128 characters');
  return p;
}

export class LinkService {
  constructor(
    private readonly deps: {
      store: Store;
      cache: Cache;
      quota: QuotaCounter;
      codes: CodeGenerator;
      policy: UrlPolicy;
      publicBaseUrl: string;
      now: () => Date;
      /** Fire-and-forget preview fetch hook (title/favicon). */
      onDestinationChanged?: (link: LinkRecord) => void;
    },
  ) {}

  toDto(link: LinkRecord): LinkDto {
    return {
      id: link.id,
      code: link.code,
      shortUrl: `${this.deps.publicBaseUrl}/${link.code}`,
      url: link.url,
      title: link.title,
      faviconUrl: link.faviconUrl,
      isCustom: link.isCustom,
      hasPassword: link.passwordHash !== null,
      expiresAt: link.expiresAt?.toISOString() ?? null,
      maxClicks: link.maxClicks,
      disabled: link.disabled,
      publicStats: link.publicStats,
      clickCount: link.clickCount,
      status: linkStatus(link, this.deps.now()),
      createdAt: link.createdAt.toISOString(),
      updatedAt: link.updatedAt.toISOString(),
    };
  }

  private validateUrl(raw: string): string {
    const check = checkDestination(raw, this.deps.policy);
    if (!check.ok) throw badRequest('invalid_url', check.reason);
    return check.url.toString();
  }

  async create(ownerId: string, input: CreateLinkInput): Promise<LinkRecord> {
    const now = this.deps.now();
    const url = this.validateUrl(input.url);
    const expiresAt = input.expiresAt ? parseFutureDate(input.expiresAt, now) : null;
    const maxClicks = input.maxClicks !== undefined ? checkMaxClicks(input.maxClicks) : null;
    const passwordHash = input.password ? await hashPassword(checkLinkPassword(input.password)) : null;
    const alias = input.alias?.trim() || undefined;
    if (alias) {
      const check = checkAlias(alias);
      if (!check.ok) throw badRequest(check.code, check.reason);
    }

    const base = (id: number, code: string): LinkRecord => ({
      id: String(id),
      code,
      ownerId,
      url,
      title: null,
      faviconUrl: null,
      isCustom: alias !== undefined,
      passwordHash,
      expiresAt,
      maxClicks,
      disabled: false,
      publicStats: input.publicStats ?? false,
      clickCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    let link: LinkRecord | null = null;
    if (alias) {
      link = base(await this.deps.codes.nextId(), alias);
      try {
        await this.deps.store.insertLink(link);
      } catch (err) {
        if (err instanceof UniqueViolation && err.field === 'code') throw conflict('alias_taken', `"${alias}" is already taken`);
        throw err;
      }
    } else {
      // Generated codes cannot collide with each other (bijection); a clash is only possible
      // with a 7-character custom alias, in which case we simply move on to the next id.
      for (let attempt = 0; attempt < 5 && !link; attempt++) {
        const { id, code } = await this.deps.codes.generate();
        const candidate = base(id, code);
        try {
          await this.deps.store.insertLink(candidate);
          link = candidate;
        } catch (err) {
          if (!(err instanceof UniqueViolation)) throw err;
        }
      }
      if (!link) throw new AppError(503, 'code_generation_failed', 'Could not allocate a short code, please retry');
    }

    // The code may be negatively cached from an earlier 404 (e.g. someone tried the alias first).
    await this.deps.cache.del(linkCacheKey(link.code));
    this.deps.onDestinationChanged?.(link);
    return link;
  }

  /** Ownership isolation: other users' links are reported as 404, never 403, so ids can't be probed. */
  async getOwned(ownerId: string, id: string): Promise<LinkRecord> {
    const link = await this.deps.store.findLinkById(id);
    if (!link || link.ownerId !== ownerId) throw notFound('Link not found');
    return link;
  }

  async list(ownerId: string, opts: { limit: number; cursor?: string; q?: string }) {
    let cursor: { createdAt: Date; id: string } | undefined;
    if (opts.cursor) {
      const [ts, id] = Buffer.from(opts.cursor, 'base64url').toString('utf8').split(':');
      const createdAt = new Date(Number(ts));
      if (!id || !/^\d+$/.test(id) || Number.isNaN(createdAt.getTime())) throw badRequest('validation_error', 'Invalid cursor');
      cursor = { createdAt, id };
    }
    const q = opts.q?.trim().slice(0, 100) || undefined;
    const rows = await this.deps.store.listLinks(ownerId, { limit: opts.limit + 1, cursor, q });
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > opts.limit && last
        ? Buffer.from(`${last.createdAt.getTime()}:${last.id}`, 'utf8').toString('base64url')
        : null;
    return { items: page, nextCursor };
  }

  async update(ownerId: string, id: string, input: UpdateLinkInput): Promise<LinkRecord> {
    const link = await this.getOwned(ownerId, id);
    const now = this.deps.now();
    const patch: LinkPatch = {};
    if (input.url !== undefined) patch.url = this.validateUrl(input.url);
    if (input.disabled !== undefined) patch.disabled = input.disabled;
    if (input.publicStats !== undefined) patch.publicStats = input.publicStats;
    if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt === null ? null : parseFutureDate(input.expiresAt, now);
    if (input.maxClicks !== undefined) patch.maxClicks = input.maxClicks === null ? null : checkMaxClicks(input.maxClicks);
    if (input.password !== undefined) {
      patch.passwordHash = input.password === null ? null : await hashPassword(checkLinkPassword(input.password));
    }
    if (patch.url !== undefined && patch.url !== link.url) {
      patch.title = null;
      patch.faviconUrl = null;
    }
    const updated = await this.deps.store.updateLink(id, patch, now);
    if (!updated) throw notFound('Link not found');
    // Cache-aside invalidation: delete, don't update, so a racing reader can't resurrect stale data for long.
    await this.deps.cache.del(linkCacheKey(updated.code));
    if (patch.url !== undefined && patch.url !== link.url) this.deps.onDestinationChanged?.(updated);
    return updated;
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const link = await this.getOwned(ownerId, id);
    await this.deps.store.deleteLink(link.id);
    await this.deps.cache.del(linkCacheKey(link.code));
    await this.deps.quota.reset(quotaKey(link.id));
  }
}
