import { setHashCost } from '../../src/lib/crypto.js';

// Argon2id at production cost (19 MiB, t=2) is deliberately slow; tests use a cheap profile.
setHashCost('fast');
