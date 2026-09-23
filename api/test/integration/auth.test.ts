import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/lib/crypto.js';
import { createTestApp, signUp, visit, type TestApp } from '../helpers/testApp.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('accounts and sessions', () => {
  it('signup -> me -> logout -> login', async () => {
    const user = await signUp(t.app, 'Hamza');
    expect(user.cookie).toMatch(/^lp_session=/);
    const me = await user.request('GET', '/api/auth/me');
    expect(me.json().user).toMatchObject({ email: user.email, name: 'Hamza' });
    expect(me.body).not.toContain('passwordHash');

    const logout = await user.request('POST', '/api/auth/logout');
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toMatch(/lp_session=;/);

    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: 'nope-nope-nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('invalid_credentials');
    const good = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email.toUpperCase(), password: 'correct-horse-battery' },
    });
    expect(good.statusCode).toBe(200);
    expect(String(good.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(good.headers['set-cookie'])).toMatch(/SameSite=Lax/i);
  });

  it('rejects duplicate emails, weak passwords and invalid emails', async () => {
    const user = await signUp(t.app);
    const signup = (payload: Record<string, string>) => t.app.inject({ method: 'POST', url: '/api/auth/signup', payload });
    expect((await signup({ email: user.email, password: 'long-enough-pass', name: 'X' })).statusCode).toBe(409);
    expect((await signup({ email: 'new@example.com', password: 'short', name: 'X' })).json().error.code).toBe('weak_password');
    expect((await signup({ email: 'not-an-email', password: 'long-enough-pass', name: 'X' })).statusCode).toBe(400);
  });

  it('requires authentication and rejects tampered sessions', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/links' })).statusCode).toBe(401);
    const forged = await t.app.inject({ method: 'GET', url: '/api/links', headers: { cookie: 'lp_session=eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' } });
    expect(forged.statusCode).toBe(401);
  });

  it('CSRF guard: cookie-authenticated writes need the X-Requested-With header', async () => {
    const user = await signUp(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { cookie: user.cookie },
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(403);
    // Reads are fine without it.
    expect((await t.app.inject({ method: 'GET', url: '/api/links', headers: { cookie: user.cookie } })).statusCode).toBe(200);
  });
});

describe('ownership isolation', () => {
  it("users can neither see nor touch each other's links (404, not 403)", async () => {
    const alice = await signUp(t.app, 'Alice');
    const bob = await signUp(t.app, 'Bob');
    const link = (await alice.request('POST', '/api/links', { url: 'https://example.com/alice' })).json();

    expect((await bob.request('GET', '/api/links')).json().items).toHaveLength(0);
    expect((await alice.request('GET', '/api/links')).json().items).toHaveLength(1);
    for (const [method, url, body] of [
      ['GET', `/api/links/${link.id}`, undefined],
      ['PATCH', `/api/links/${link.id}`, { url: 'https://evil.example.org' }],
      ['DELETE', `/api/links/${link.id}`, undefined],
      ['GET', `/api/links/${link.id}/analytics`, undefined],
      ['GET', `/api/links/${link.id}/analytics.csv`, undefined],
      ['GET', `/api/links/${link.id}/qr.svg`, undefined],
      ['GET', `/api/links/${link.id}/events`, undefined],
    ] as const) {
      const res = await bob.request(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // Alice's link is untouched.
    expect((await visit(t.app, link.code)).headers.location).toBe('https://example.com/alice');
  });

  it('paginates with a cursor and searches only within the owner’s links', async () => {
    const user = await signUp(t.app);
    for (let i = 0; i < 5; i++) {
      await user.request('POST', '/api/links', { url: `https://example.com/page-${i}` });
      t.clock.advance(1000);
    }
    const page1 = (await user.request('GET', '/api/links?limit=2')).json();
    expect(page1.items.map((l: { url: string }) => l.url)).toEqual(['https://example.com/page-4', 'https://example.com/page-3']);
    const page2 = (await user.request('GET', `/api/links?limit=2&cursor=${page1.nextCursor}`)).json();
    expect(page2.items.map((l: { url: string }) => l.url)).toEqual(['https://example.com/page-2', 'https://example.com/page-1']);
    const page3 = (await user.request('GET', `/api/links?limit=2&cursor=${page2.nextCursor}`)).json();
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
    expect((await user.request('GET', '/api/links?q=page-3')).json().items).toHaveLength(1);
  });
});

describe('API keys', () => {
  it('are shown once, stored hashed, usable as Bearer tokens, and revocable', async () => {
    const user = await signUp(t.app);
    const created = await user.request('POST', '/api/keys', { name: 'CI pipeline' });
    expect(created.statusCode).toBe(201);
    const { key, secret } = created.json();
    expect(secret).toMatch(/^lp_live_[0-9A-Za-z]{32}$/);
    expect(key.prefix).toBe(secret.slice(0, 12));

    // Only the SHA-256 is persisted.
    const stored = await t.infra.store.findApiKeyByHash(sha256Hex(secret));
    expect(stored?.keyHash).toBe(sha256Hex(secret));
    expect(JSON.stringify(await t.infra.store.listApiKeys(user.userId))).not.toContain(secret);
    expect((await user.request('GET', '/api/keys')).body).not.toContain(secret);

    const bearer = (s: string) => ({ authorization: `Bearer ${s}` });
    const viaKey = await t.app.inject({ method: 'POST', url: '/api/links', headers: bearer(secret), payload: { url: 'https://example.com/api' } });
    expect(viaKey.statusCode).toBe(201); // no CSRF header needed for API keys
    const list = await t.app.inject({ method: 'GET', url: '/api/links', headers: bearer(secret) });
    expect(list.json().items).toHaveLength(1);

    expect((await user.request('DELETE', `/api/keys/${key.id}`)).statusCode).toBe(204);
    const revoked = await t.app.inject({ method: 'GET', url: '/api/links', headers: bearer(secret) });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error.code).toBe('invalid_api_key');
  });

  it("a key only ever acts as its owner, and users can't revoke others' keys", async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);
    const { key, secret } = (await alice.request('POST', '/api/keys', { name: 'alice-key' })).json();
    await bob.request('POST', '/api/links', { url: 'https://example.com/bob' });
    const res = await t.app.inject({ method: 'GET', url: '/api/links', headers: { authorization: `Bearer ${secret}` } });
    expect(res.json().items).toHaveLength(0);
    expect((await bob.request('DELETE', `/api/keys/${key.id}`)).statusCode).toBe(404);
    const bogus = await t.app.inject({ method: 'GET', url: '/api/links', headers: { authorization: 'Bearer lp_live_notarealkey' } });
    expect(bogus.statusCode).toBe(401);
  });
});
