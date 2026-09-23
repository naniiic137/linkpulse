import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { extractPreview, guardedLookup, safeFetchHtml, SsrfBlockedError } from '../../src/lib/safeFetch.js';
import { checkAlias, checkDestination, isPrivateIp } from '../../src/lib/urlSafety.js';

const policy = { selfHosts: ['lp.test'], blockedDomains: ['evil.example'] };
const reason = (url: string) => {
  const r = checkDestination(url, policy);
  return r.ok ? null : r.reason;
};

describe('checkDestination', () => {
  it('accepts ordinary http(s) URLs and normalises them', () => {
    const r = checkDestination('  https://Example.com/a?b=1#c ', policy);
    expect(r.ok && r.url.toString()).toBe('https://example.com/a?b=1#c');
    expect(reason('http://sub.domain.co.uk:8080/path')).toBeNull();
    expect(reason('https://8.8.8.8/dns')).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(document.cookie)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'ftp://files.example.com/x',
    'mailto:someone@example.com',
  ])('refuses dangerous or non-web scheme %s', (url) => {
    expect(reason(url)).toMatch(/not allowed/);
  });

  it.each([
    'http://127.0.0.1/admin',
    'http://localhost:3000',
    'http://api.localhost/',
    'http://10.0.0.5/',
    'http://172.16.3.4/',
    'http://192.168.1.1/router',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata endpoint
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://2130706433/', // 127.0.0.1 as a decimal integer
    'http://0x7f.0.0.1/', // hex octet
    'http://017700000001/', // octal
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6
    'http://printer.local/',
    'http://intranet/',
  ])('refuses private / local target %s', (url) => {
    expect(reason(url)).not.toBeNull();
  });

  it('refuses credentials, self-links, blocklisted domains and oversized URLs', () => {
    expect(reason('https://user:pass@example.com/')).toMatch(/credentials/);
    expect(reason('https://lp.test/abc1234')).toMatch(/redirect loop/);
    expect(reason('https://evil.example/login')).toMatch(/blocklist/);
    expect(reason('https://login.evil.example/')).toMatch(/blocklist/);
    expect(reason('https://malware.test/')).toMatch(/blocklist/);
    expect(reason(`https://example.com/${'a'.repeat(2100)}`)).toMatch(/at most/);
    expect(reason('not a url')).toMatch(/valid/);
    expect(reason('')).toMatch(/required/);
  });
});

describe('isPrivateIp', () => {
  it('classifies v4, v6 and mapped addresses', () => {
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fc00::abcd')).toBe(true);
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIp('::ffff:5db8:d822')).toBe(false);
  });
});

describe('checkAlias', () => {
  it('validates shape and blocks reserved words case-insensitively', () => {
    expect(checkAlias('spring-sale_2026')).toEqual({ ok: true });
    expect(checkAlias('ab')).toMatchObject({ ok: false, code: 'invalid_alias' });
    expect(checkAlias('-leading')).toMatchObject({ ok: false, code: 'invalid_alias' });
    expect(checkAlias('has space')).toMatchObject({ ok: false, code: 'invalid_alias' });
    expect(checkAlias('a'.repeat(33))).toMatchObject({ ok: false, code: 'invalid_alias' });
    expect(checkAlias('../etc')).toMatchObject({ ok: false, code: 'invalid_alias' });
    for (const word of ['api', 'Docs', 'LOGIN', 'stats', 'health', 'app']) {
      expect(checkAlias(word)).toMatchObject({ ok: false, code: 'reserved_alias' });
    }
  });
});

describe('SSRF-safe preview fetch', () => {
  const resolver = (map: Record<string, string[]>) => async (host: string): Promise<LookupAddress[]> =>
    (map[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('guardedLookup refuses hostnames that resolve to private addresses (DNS rebinding)', async () => {
    const lookup = guardedLookup(resolver({ 'rebind.example.com': ['93.184.216.34', '10.0.0.7'] }));
    const err = await new Promise<Error | null>((resolve) => lookup('rebind.example.com', {}, (e) => resolve(e)));
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it('guardedLookup passes public addresses through (single and all modes)', async () => {
    const lookup = guardedLookup(resolver({ 'ok.example.com': ['93.184.216.34'] }));
    const single = await new Promise<string>((resolve, reject) =>
      lookup('ok.example.com', {}, (e, addr) => (e ? reject(e) : resolve(addr as string))),
    );
    expect(single).toBe('93.184.216.34');
    const all = await new Promise<unknown>((resolve, reject) =>
      lookup('ok.example.com', { all: true }, (e, addrs) => (e ? reject(e) : resolve(addrs))),
    );
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('safeFetchHtml never connects to an internal host', async () => {
    await expect(
      safeFetchHtml('http://metadata.example.com/latest', {
        policy,
        resolve: resolver({ 'metadata.example.com': ['169.254.169.254'] }),
      }),
    ).rejects.toThrow(/non-public/);
    await expect(safeFetchHtml('http://127.0.0.1/', { policy })).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(safeFetchHtml('https://example.com:8443/', { policy })).rejects.toThrow(/ports/);
  });

  it('extracts title (og:title preferred) and favicon', () => {
    const html = `<html><head><title>Plain &amp; simple</title>
      <meta property="og:title" content="Launch day"><link rel="icon" href="/static/icon.png"></head></html>`;
    expect(extractPreview(html, 'https://example.com/page')).toEqual({
      title: 'Launch day',
      faviconUrl: 'https://example.com/static/icon.png',
    });
    expect(extractPreview('<title>Only &amp; title</title>', 'https://example.com/')).toEqual({
      title: 'Only & title',
      faviconUrl: 'https://example.com/favicon.ico',
    });
  });
});
