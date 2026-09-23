import { randomUUID } from 'node:crypto';
import { AppError, badRequest, conflict, UniqueViolation } from '../domain/errors.js';
import type { ApiKeyRecord, User } from '../domain/types.js';
import { generateApiKey, hashPassword, sha256Hex, verifyPassword } from '../lib/crypto.js';
import type { Store } from '../stores/types.js';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const MIN_PASSWORD = 10;
const MAX_KEYS_PER_USER = 10;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export const toPublicUser = (u: User): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  createdAt: u.createdAt.toISOString(),
});

export interface PublicApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const toPublicKey = (k: ApiKeyRecord): PublicApiKey => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  createdAt: k.createdAt.toISOString(),
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
});

/** A valid Argon2id hash of a random string: lets unknown-email logins cost the same as real ones. */
let dummyHash: Promise<string> | null = null;

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async signup(input: { email: string; password: string; name: string }): Promise<User> {
    const email = input.email.trim();
    const name = input.name.trim();
    if (!EMAIL.test(email)) throw badRequest('validation_error', 'Enter a valid email address');
    if (input.password.length < MIN_PASSWORD) {
      throw badRequest('weak_password', `Password must be at least ${MIN_PASSWORD} characters`);
    }
    if (input.password.length > 200) throw badRequest('validation_error', 'Password is too long');
    if (!name || name.length > 80) throw badRequest('validation_error', 'Name must be 1-80 characters');
    const user: User = {
      id: randomUUID(),
      email,
      name,
      passwordHash: await hashPassword(input.password),
      createdAt: this.now(),
    };
    try {
      await this.store.createUser(user);
    } catch (err) {
      if (err instanceof UniqueViolation) throw conflict('email_taken', 'An account with this email already exists');
      throw err;
    }
    return user;
  }

  async login(email: string, password: string): Promise<User> {
    const user = await this.store.findUserByEmail(email.trim());
    if (!user) {
      dummyHash ??= hashPassword(randomUUID());
      await verifyPassword(await dummyHash, password);
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    return user;
  }

  async authenticateApiKey(secret: string): Promise<{ userId: string; keyId: string } | null> {
    if (!secret.startsWith('lp_')) return null;
    const key = await this.store.findApiKeyByHash(sha256Hex(secret));
    if (!key) return null;
    const now = this.now();
    // Throttle last-used writes to one per minute per key.
    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
      void this.store.touchApiKey(key.id, now).catch(() => {});
    }
    return { userId: key.userId, keyId: key.id };
  }

  async createApiKey(userId: string, name: string): Promise<{ key: ApiKeyRecord; secret: string }> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60) throw badRequest('validation_error', 'Key name must be 1-60 characters');
    const existing = await this.store.listApiKeys(userId);
    if (existing.length >= MAX_KEYS_PER_USER) {
      throw badRequest('too_many_keys', `You can have at most ${MAX_KEYS_PER_USER} API keys`);
    }
    const { secret, prefix, hash } = generateApiKey();
    const key: ApiKeyRecord = {
      id: randomUUID(),
      userId,
      name: trimmed,
      prefix,
      keyHash: hash,
      createdAt: this.now(),
      lastUsedAt: null,
    };
    await this.store.createApiKey(key);
    return { key, secret };
  }

  listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    return this.store.listApiKeys(userId);
  }

  deleteApiKey(userId: string, id: string): Promise<boolean> {
    return this.store.deleteApiKey(userId, id);
  }
}
