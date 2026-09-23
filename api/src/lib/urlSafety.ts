import { BlockList, isIP } from 'node:net';

export const MAX_URL_LENGTH = 2048;

/**
 * Aliases that would shadow application routes (SPA pages, API, docs, health
 * probes) or are simply confusing. Compared case-insensitively.
 */
export const RESERVED_ALIASES = new Set([
  'about', 'admin', 'api', 'app', 'assets', 'auth', 'dashboard', 'docs', 'favicon', 'health',
  'help', 'index', 'keys', 'linkpulse', 'login', 'logout', 'metrics', 'null', 'public', 'ready',
  'robots', 'root', 'settings', 'signup', 'static', 'stats', 'status', 'support', 'undefined', 'www',
]);

export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;
/** Anything that could be a short code or alias; used to reject junk before touching storage. */
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;

/** A tiny built-in blocklist; extend at runtime with BLOCKED_DOMAINS. */
const DEFAULT_BLOCKED_DOMAINS = ['malware.test', 'phishing.test', 'example-malware.invalid'];

/** Private, loopback, link-local, CGNAT, multicast and other non-public ranges. */
const privateRanges = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv6');
}

/** True for any address that must never be reached by server-side fetches. */
export function isPrivateIp(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const version = isIP(ip);
  if (version === 4) return privateRanges.check(ip, 'ipv4');
  if (version === 6) {
    // IPv4-mapped / compatible forms (::ffff:127.0.0.1, ::ffff:7f00:1) inherit the v4 verdict.
    const mapped = ip.toLowerCase().match(/^::ffff:(?:0:)?(.+)$/);
    if (mapped) {
      const rest = mapped[1]!;
      if (isIP(rest) === 4) return privateRanges.check(rest, 'ipv4');
      const hex = rest.split(':');
      if (hex.length === 2) {
        const hi = Number.parseInt(hex[0]!, 16);
        const lo = Number.parseInt(hex[1]!, 16);
        return privateRanges.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
      }
      return true;
    }
    return privateRanges.check(ip, 'ipv6');
  }
  return false;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export interface UrlPolicy {
  /** Host of the shortener itself: links pointing back at it would create redirect loops. */
  selfHosts: string[];
  blockedDomains: string[];
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Validate a destination URL at link-creation time.
 * The WHATWG URL parser normalises tricks like `http://2130706433/` or
 * `http://0x7f.1/` to `127.0.0.1`, so checking the parsed hostname is sound.
 */
export function checkDestination(raw: string, policy: UrlPolicy): UrlCheck {
  const input = raw.trim();
  if (input.length === 0) return { ok: false, reason: 'URL is required' };
  if (input.length > MAX_URL_LENGTH) return { ok: false, reason: `URL must be at most ${MAX_URL_LENGTH} characters` };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'Not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Scheme "${url.protocol}" is not allowed; use http or https` };
  }
  if (url.username || url.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed' };

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'URL must include a host' };
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (isPrivateIp(bare)) return { ok: false, reason: 'Private, loopback and link-local addresses are not allowed' };
  } else {
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) {
      return { ok: false, reason: 'Local hostnames are not allowed' };
    }
    if (!host.includes('.')) return { ok: false, reason: 'Hostname must be a fully-qualified domain' };
  }
  if (policy.selfHosts.some((self) => host === self.toLowerCase())) {
    return { ok: false, reason: 'Links to this shortener would create a redirect loop' };
  }
  const blocked = [...DEFAULT_BLOCKED_DOMAINS, ...policy.blockedDomains].find((d) => hostMatches(host, d));
  if (blocked) return { ok: false, reason: 'This domain is on the blocklist' };

  return { ok: true, url };
}

export type AliasCheck = { ok: true } | { ok: false; code: 'invalid_alias' | 'reserved_alias'; reason: string };

export function checkAlias(alias: string): AliasCheck {
  if (!ALIAS_PATTERN.test(alias)) {
    return {
      ok: false,
      code: 'invalid_alias',
      reason: 'Alias must be 3-32 characters: letters, digits, "-" or "_", starting with a letter or digit',
    };
  }
  if (RESERVED_ALIASES.has(alias.toLowerCase())) {
    return { ok: false, code: 'reserved_alias', reason: `"${alias}" is reserved` };
  }
  return { ok: true };
}
