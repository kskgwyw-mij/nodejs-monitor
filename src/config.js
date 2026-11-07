import { randomBytes } from 'node:crypto';

const MIN_SECRET_LENGTH = 32;

function parseIntInRange(value, name, { min, max, fallback }) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') {
    // "true" trusts every hop, which lets clients spoof their IP via X-Forwarded-For.
    throw new Error('TRUST_PROXY=true is unsafe; set the number of proxy hops (e.g. 1) or "loopback"');
  }
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback", "10.0.0.0/8"
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Accepts only https URLs (plain http is allowed for loopback, e.g. a local test server). */
function parseServiceUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} contains an invalid URL: ${value}`);
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!ok || url.username || url.password) throw new Error(`${name} must use https:// URLs without credentials`);
  return url;
}

function parseOverpassUrls(value) {
  const list = (value || 'https://overpass-api.de/api/interpreter')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0 || list.length > 5) throw new Error('OVERPASS_URLS must list 1–5 endpoints');
  return Object.freeze(list.map((u) => parseServiceUrl(u, 'OVERPASS_URLS').href));
}

function parseTileUrl(value) {
  const raw = value || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  if (!/\{z\}/.test(raw) || !/\{x\}/.test(raw) || !/\{y\}/.test(raw)) {
    throw new Error('MAP_TILE_URL must contain {z}, {x} and {y}');
  }
  const origin = parseServiceUrl(raw.replace(/\{[a-z]\}/g, '0'), 'MAP_TILE_URL').origin;
  return { tileUrl: raw, tileOrigin: origin };
}

function parseDefaultView(value) {
  const [lat, lon, zoom] = (value || '52.5163,13.3777,16').split(',').map(Number);
  if (!(Math.abs(lat) <= 85) || !(Math.abs(lon) <= 180) || !Number.isInteger(zoom) || zoom < 2 || zoom > 19) {
    throw new Error('MAP_DEFAULT_VIEW must be "lat,lon,zoom" (zoom 2–19)');
  }
  return Object.freeze({ lat, lon, zoom });
}

/**
 * Reads configuration from environment variables and validates it.
 * Fails fast (throws) on anything unsafe for production.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const secrets = (env.SESSION_SECRET || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (secrets.length === 0) {
    if (isProduction) {
      throw new Error('SESSION_SECRET is required in production');
    }
    // Dev only: random per-process secret (sessions reset on restart).
    secrets.push(randomBytes(48).toString('base64url'));
  }
  if (secrets.some((s) => s.length < MIN_SECRET_LENGTH)) {
    throw new Error(`SESSION_SECRET values must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const tlsCertFile = env.TLS_CERT_FILE || null;
  const tlsKeyFile = env.TLS_KEY_FILE || null;
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be set together');
  }
  const tls = tlsCertFile ? { certFile: tlsCertFile, keyFile: tlsKeyFile } : null;

  // Cookies are marked Secure whenever the site is (or should be) served over HTTPS.
  const secureCookies = isProduction || Boolean(tls);

  return Object.freeze({
    nodeEnv,
    isProduction,
    host: env.HOST || '127.0.0.1',
    port: parseIntInRange(env.PORT, 'PORT', { min: 0, max: 65535, fallback: 3000 }),
    databasePath: env.DATABASE_PATH || './data/app.db',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionSecrets: Object.freeze(secrets),
    secureCookies,
    tls,
    logRequests: env.LOG_REQUESTS !== 'false',
    session: Object.freeze({
      // Idle timeout: session expires after this long without activity.
      idleTimeoutMs: 2 * 60 * 60 * 1000,
      // Absolute timeout: re-authentication required after this long regardless of activity.
      absoluteTimeoutMs: 12 * 60 * 60 * 1000,
    }),
    rateLimits: Object.freeze({
      global: { windowMs: 15 * 60 * 1000, limit: 600 },
      login: { windowMs: 15 * 60 * 1000, limit: 10 },
      register: { windowMs: 60 * 60 * 1000, limit: 10 },
      osmApi: { windowMs: 60 * 1000, limit: 30 },
    }),
    map: Object.freeze({
      ...parseTileUrl(env.MAP_TILE_URL),
      defaultView: parseDefaultView(env.MAP_DEFAULT_VIEW),
      // Below this zoom level the visible area is too large to query.
      minDataZoom: 15,
    }),
    overpass: Object.freeze({
      endpoints: parseOverpassUrls(env.OVERPASS_URLS),
      userAgent: env.OVERPASS_USER_AGENT || 'SecureNotes/1.0 (Node.js; OpenStreetMap category viewer)',
      timeoutMs: 25_000,
      maxElements: 5000,
      maxResponseBytes: 15 * 1024 * 1024,
      cacheTtlMs: 10 * 60 * 1000,
      cacheMaxEntries: 300,
      maxConcurrent: 2,
      maxQueued: 20,
    }),
  });
}
