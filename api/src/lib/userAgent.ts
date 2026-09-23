import { isbot } from 'isbot';
import { UAParser } from 'ua-parser-js';

export interface ParsedAgent {
  device: string;
  browser: string;
  os: string;
}

/**
 * Bot detection runs on the redirect hot path (to keep crawlers and link
 * unfurlers like Slackbot from burning a link's max-clicks quota), so it must
 * be cheap: `isbot` is a single precompiled regex. Empty user agents are
 * treated as bots too (real browsers always send one).
 */
export function isBotAgent(userAgent: string | undefined): boolean {
  if (!userAgent || userAgent.trim() === '') return true;
  return isbot(userAgent) || /\b(curl|wget|httpie|python-requests|go-http-client|okhttp|java\/|axios|node-fetch|undici|autocannon)\b/i.test(userAgent);
}

/** Full UA parsing is comparatively expensive, so it happens off the hot path, in the analytics flusher. */
export function parseAgent(userAgent: string): ParsedAgent {
  const r = new UAParser(userAgent).getResult();
  const deviceType = r.device.type; // mobile | tablet | console | smarttv | wearable | embedded | undefined
  let device: string;
  if (deviceType === 'mobile' || deviceType === 'tablet') device = deviceType;
  else if (deviceType) device = 'other';
  else device = userAgent ? 'desktop' : 'unknown';
  return {
    device,
    browser: r.browser.name ?? 'Other',
    os: r.os.name ?? 'Other',
  };
}

/** Normalise a Referer header into a hostname ("direct" when absent or unparsable). */
export function referrerHost(referer: string | null | undefined): string {
  if (!referer) return 'direct';
  try {
    const host = new URL(referer).hostname.toLowerCase().replace(/^www\./, '');
    return host || 'direct';
  } catch {
    return 'direct';
  }
}

const COUNTRY = /^[A-Z]{2}$/;

/**
 * Country comes from an edge/CDN header (Cloudflare's CF-IPCountry, or an
 * X-Country header set by your own proxy). We never do GeoIP lookups
 * ourselves. "XX" (unknown) and "T1" (Tor) map to null.
 */
export function normaliseCountry(value: string | string[] | undefined): string | null {
  const v = (Array.isArray(value) ? value[0] : value)?.trim().toUpperCase();
  if (!v || !COUNTRY.test(v) || v === 'XX' || v === 'T1') return null;
  return v;
}
