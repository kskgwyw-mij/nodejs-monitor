/**
 * Server-side client for the OpenStreetMap Overpass API.
 *
 * The browser never talks to Overpass directly: it asks our /api/osm/features
 * endpoint, which validates the bounding box, serves from cache when possible,
 * and only then queries Overpass. This keeps the CSP strict (connect-src 'self'),
 * lets us rate-limit and cache, and respects Overpass' fair-use policy.
 */

// Top-level OSM keys that classify points of interest ("map features").
export const CATEGORY_KEYS = Object.freeze([
  'amenity',
  'shop',
  'tourism',
  'leisure',
  'historic',
  'office',
  'craft',
  'healthcare',
  'emergency',
  'public_transport',
]);

const MAX_NAME_LENGTH = 120;
const MAX_VALUE_LENGTH = 64;
const MAX_VALUES_PER_KEY = 3;
const ENDPOINT_BACKOFF_MS = 60_000;
const TYPE_CODES = { node: 'n', way: 'w', relation: 'r' };

export class OverpassError extends Error {
  constructor(message, { busy = false } = {}) {
    super(message);
    this.name = 'OverpassError';
    this.busy = busy;
  }
}

/**
 * Builds the Overpass QL query. Only validated numbers and the constant key
 * list above are interpolated, so the query can't be injected into.
 */
export function buildQuery({ south, west, north, east }, { maxElements, timeoutSeconds }) {
  const bbox = [south, west, north, east].map((v) => v.toFixed(4)).join(',');
  const selectors = CATEGORY_KEYS.map((k) => `nwr["${k}"];`).join('');
  return (
    `[out:json][timeout:${timeoutSeconds}][bbox:${bbox}];` +
    `(${selectors})->.poi;` +
    // Nodes carry their own coordinates; ways/relations get a computed center point.
    `node.poi;out qt ${maxElements};` +
    `(way.poi;relation.poi;);out tags center qt ${maxElements};`
  );
}

const cleanString = (value, max) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

/** Converts raw Overpass elements into a compact, size-bounded feature list. */
export function normalizeElements(elements) {
  const features = [];
  for (const el of Array.isArray(elements) ? elements : []) {
    const type = TYPE_CODES[el?.type];
    const id = el?.id;
    const lat = el?.lat ?? el?.center?.lat;
    const lon = el?.lon ?? el?.center?.lon;
    const tags = el?.tags;
    if (!type || !Number.isSafeInteger(id) || id <= 0) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (!tags || typeof tags !== 'object') continue;

    const categories = [];
    for (const key of CATEGORY_KEYS) {
      if (!Object.hasOwn(tags, key)) continue;
      // OSM allows several values separated by ";" (e.g. "cafe;bakery").
      const values = cleanString(tags[key], MAX_VALUE_LENGTH * MAX_VALUES_PER_KEY)
        .split(';')
        .map((v) => v.trim().slice(0, MAX_VALUE_LENGTH))
        .filter((v) => v && v !== 'no')
        .slice(0, MAX_VALUES_PER_KEY);
      for (const value of values) categories.push([key, value]);
    }
    if (categories.length === 0) continue;

    const feature = { t: type, id, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, c: categories };
    const name = cleanString(tags.name, MAX_NAME_LENGTH);
    if (name) feature.name = name;
    features.push(feature);
  }
  return features;
}

/** Minimal counting semaphore with a bounded wait queue. */
class Limiter {
  #active = 0;
  #queue = [];
  constructor(max, maxQueue) {
    this.max = max;
    this.maxQueue = maxQueue;
  }
  async run(fn) {
    if (this.#active >= this.max) {
      if (this.#queue.length >= this.maxQueue) throw new OverpassError('Map data service is busy', { busy: true });
      await new Promise((resolve) => this.#queue.push(resolve));
    }
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}

export class OverpassClient {
  #cache = new Map(); // key -> { expires, value }  (Map keeps insertion order => simple LRU)
  #inflight = new Map(); // key -> Promise
  #downUntil = new Map(); // endpoint -> timestamp
  #limiter;

  constructor({
    endpoints,
    userAgent,
    timeoutMs = 25_000,
    maxElements = 5000,
    maxResponseBytes = 15 * 1024 * 1024,
    cacheTtlMs = 10 * 60 * 1000,
    cacheMaxEntries = 300,
    maxConcurrent = 2,
    maxQueued = 20,
    fetchImpl = globalThis.fetch,
  }) {
    if (!endpoints?.length) throw new Error('At least one Overpass endpoint is required');
    Object.assign(this, { endpoints, userAgent, timeoutMs, maxElements, maxResponseBytes, cacheTtlMs, cacheMaxEntries });
    this.fetch = fetchImpl;
    this.#limiter = new Limiter(maxConcurrent, maxQueued);
  }

  /** Returns { features, truncated, fetchedAt } for a (validated, snapped) bbox. */
  async features(bbox) {
    const key = [bbox.south, bbox.west, bbox.north, bbox.east].map((v) => v.toFixed(4)).join(',');

    const hit = this.#cache.get(key);
    if (hit && hit.expires > Date.now()) {
      this.#cache.delete(key); // refresh LRU position
      this.#cache.set(key, hit);
      return hit.value;
    }

    // Concurrent requests for the same area share one upstream query.
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#limiter
        .run(() => this.#query(bbox))
        .then((value) => {
          this.#cache.set(key, { expires: Date.now() + this.cacheTtlMs, value });
          while (this.#cache.size > this.cacheMaxEntries) this.#cache.delete(this.#cache.keys().next().value);
          return value;
        })
        .finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return pending;
  }

  async #query(bbox) {
    const query = buildQuery(bbox, {
      maxElements: this.maxElements,
      timeoutSeconds: Math.max(5, Math.floor(this.timeoutMs / 1000) - 2),
    });

    // Try healthy endpoints first; endpoints that recently failed are tried last.
    const now = Date.now();
    const ordered = [...this.endpoints].sort(
      (a, b) => Number((this.#downUntil.get(a) ?? 0) > now) - Number((this.#downUntil.get(b) ?? 0) > now),
    );

    let lastError;
    for (const endpoint of ordered) {
      try {
        const data = await this.#fetchJson(endpoint, query);
        this.#downUntil.delete(endpoint);
        const nodes = data.elements.filter((e) => e?.type === 'node').length;
        const others = data.elements.length - nodes;
        return {
          features: normalizeElements(data.elements),
          truncated: nodes >= this.maxElements || others >= this.maxElements,
          fetchedAt: new Date().toISOString(),
        };
      } catch (err) {
        lastError = err;
        this.#downUntil.set(endpoint, Date.now() + ENDPOINT_BACKOFF_MS);
        console.warn(`Overpass endpoint failed (${new URL(endpoint).host}): ${err.message}`);
      }
    }
    throw new OverpassError(`All Overpass endpoints failed: ${lastError?.message}`);
  }

  async #fetchJson(endpoint, query) {
    const res = await this.fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        accept: 'application/json',
        'user-agent': this.userAgent,
      },
      body: new URLSearchParams({ data: query }).toString(),
      redirect: 'error', // never follow redirects to unexpected hosts
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }

    // Read the body with a hard size cap.
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > this.maxResponseBytes) throw new Error('response too large');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || !Array.isArray(data.elements)) throw new Error('unexpected response format');
    // Overpass reports query timeouts/out-of-memory as a "remark" on an HTTP 200.
    if (typeof data.remark === 'string' && /error/i.test(data.remark)) {
      throw new Error('upstream query error');
    }
    return data;
  }
}
