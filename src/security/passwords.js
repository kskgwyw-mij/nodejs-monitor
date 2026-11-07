import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// OWASP Password Storage Cheat Sheet scrypt profile: N=2^15 (32 MiB), r=8, p=3.
const PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 3 });
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

const maxmemFor = ({ N, r }) => 128 * N * r * 2;

/** Normalize so visually identical passwords hash identically (NIST SP 800-63B). */
const normalize = (password) => password.normalize('NFKC');

/** Returns a self-describing hash string: scrypt$N$r$p$salt$hash */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(normalize(password), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: maxmemFor(PARAMS),
  });
  return [PREFIX, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function parse(stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Bound the parameters so a tampered hash can't be used to exhaust memory/CPU.
  if (!Number.isInteger(Math.log2(N)) || N < 2 ** 14 || N > 2 ** 20) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (salt.length < 16 || key.length !== KEY_LENGTH) return null;
  return { N, r, p, salt, key };
}

/** Constant-time verification. Returns false (never throws) for malformed hashes. */
export async function verifyPassword(password, stored) {
  const parsed = parse(stored);
  if (!parsed) return false;
  const { salt, key, ...params } = parsed;
  const candidate = await scryptAsync(normalize(password), salt, KEY_LENGTH, {
    ...params,
    maxmem: maxmemFor(params),
  });
  return timingSafeEqual(candidate, key);
}

/** True when a stored hash uses weaker-than-current parameters and should be upgraded. */
export function needsRehash(stored) {
  const parsed = parse(stored);
  return !parsed || parsed.N < PARAMS.N || parsed.r < PARAMS.r || parsed.p < PARAMS.p;
}

// Used to equalize timing when a login is attempted for a non-existent user,
// so response times don't reveal which usernames exist.
let dummyHashPromise;
export function dummyHash() {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('base64'));
  return dummyHashPromise;
}
