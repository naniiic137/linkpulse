import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { checkDestination, isPrivateIp, type UrlPolicy } from './urlSafety.js';

/**
 * Server-side fetch with SSRF protections, used for link previews
 * (title + favicon). Defence in depth:
 *
 *  1. URL policy: http(s) only, ports 80/443, no credentials, no private IP
 *     literals or local hostnames (same checks as link creation).
 *  2. DNS pinning: the address check runs *inside* the socket's `lookup`
 *     hook, i.e. on the exact IP we connect to. A hostname that resolves to
 *     10.0.0.5 (or re-resolves to it later: DNS rebinding) is refused.
 *  3. Every redirect hop is re-validated from step 1 (max 3 hops).
 *  4. Hard limits: total timeout, response size cap, HTML-only.
 */

export interface SafeFetchOptions {
  policy: UrlPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Injectable resolver (tests). */
  resolve?: (host: string) => Promise<LookupAddress[]>;
}

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const defaultResolve = (host: string) =>
  new Promise<LookupAddress[]>((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))),
  );

/** Build a `lookup` hook that refuses to connect to non-public addresses. */
export function guardedLookup(resolve: (host: string) => Promise<LookupAddress[]>): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0) throw new Error(`No addresses for ${hostname}`);
        const bad = addresses.find((a) => isPrivateIp(a.address));
        if (bad) throw new SsrfBlockedError(`${hostname} resolves to a non-public address (${bad.address})`);
        const family = typeof options === 'object' && options ? options.family : undefined;
        const usable = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        if (usable.length === 0) throw new Error(`No IPv${String(family)} address for ${hostname}`);
        if (typeof options === 'object' && options && options.all) {
          (callback as unknown as (err: null, addrs: LookupAddress[]) => void)(null, usable);
        } else {
          callback(null, usable[0]!.address, usable[0]!.family);
        }
      })
      .catch((err: Error) => callback(err as NodeJS.ErrnoException, '', 4));
  };
}

export interface FetchedPage {
  finalUrl: string;
  html: string;
}

export async function safeFetchHtml(rawUrl: string, opts: SafeFetchOptions): Promise<FetchedPage> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const lookup = guardedLookup(opts.resolve ?? defaultResolve);
  const deadline = Date.now() + timeoutMs;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = checkDestination(current, opts.policy);
    if (!check.ok) throw new SsrfBlockedError(check.reason);
    const url = check.url;
    if (url.port && url.port !== '80' && url.port !== '443') throw new SsrfBlockedError('Only ports 80 and 443 are allowed');

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Preview fetch timed out');
    const res = await request(url, lookup, remaining, maxBytes);
    if (res.redirect) {
      current = new URL(res.redirect, url).toString();
      continue;
    }
    return { finalUrl: url.toString(), html: res.body };
  }
  throw new Error('Too many redirects');
}

function request(
  url: URL,
  lookup: LookupFunction,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ redirect?: string; body: string }> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        lookup,
        timeout: timeoutMs,
        headers: { 'user-agent': 'LinkPulsePreview/1.0 (+link preview bot)', accept: 'text/html' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ redirect: res.headers.location, body: '' });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Upstream responded ${status}`));
          return;
        }
        const type = String(res.headers['content-type'] ?? '');
        if (!type.includes('text/html')) {
          res.resume();
          reject(new Error(`Not HTML (${type || 'no content-type'})`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Enough for <head>; stop reading instead of failing.
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
            res.destroy();
            resolve({ body: Buffer.concat(chunks).toString('utf8') });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Preview fetch timed out')));
    req.on('error', reject);
  });
}

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** Extract a page title and favicon URL from HTML (og:title preferred). */
export function extractPreview(html: string, pageUrl: string): { title: string | null; faviconUrl: string | null } {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const tag = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  const rawTitle = og?.[1] ?? tag?.[1] ?? null;
  const title = rawTitle ? decodeEntities(rawTitle).slice(0, 200) || null : null;

  let faviconUrl: string | null = null;
  const icon = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>/i)?.[0];
  const href = icon?.match(/href=["']([^"']+)["']/i)?.[1];
  try {
    faviconUrl = new URL(href ?? '/favicon.ico', pageUrl).toString();
    if (!/^https?:/.test(faviconUrl)) faviconUrl = null;
  } catch {
    faviconUrl = null;
  }
  return { title, faviconUrl };
}
