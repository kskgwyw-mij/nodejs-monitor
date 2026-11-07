import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { bboxArea, parseBbox, snapBbox } from '../src/osm/bbox.js';
import { buildQuery, normalizeElements } from '../src/osm/overpass.js';

const TEST_ENV = { NODE_ENV: 'test', SESSION_SECRET: 'test-secret-'.padEnd(48, 'x'), LOG_REQUESTS: 'false' };
const BBOX = '52.51301,13.37012,52.51899,13.38288';

const FIXTURE = {
  version: 0.6,
  elements: [
    { type: 'node', id: 1, lat: 52.5163, lon: 13.3777, tags: { tourism: 'attraction', historic: 'monument', name: 'Brandenburger Tor' } },
    { type: 'node', id: 2, lat: 52.5170, lon: 13.3790, tags: { amenity: 'cafe', name: '<img src=x onerror=alert(1)>' } },
    { type: 'node', id: 3, lat: 52.5150, lon: 13.3800, tags: { amenity: 'restaurant;bar', shop: 'no' } },
    { type: 'way', id: 4, center: { lat: 52.5140, lon: 13.3750 }, tags: { leisure: 'park', name: 'Tiergarten' } },
    { type: 'node', id: 5, tags: { amenity: 'bench' } }, // no coordinates -> dropped
    { type: 'node', id: 6, lat: 52.516, lon: 13.38, tags: { highway: 'crossing' } }, // no category key -> dropped
    { type: 'node', id: 7, lat: 52.516, lon: 13.38, tags: { shop: 'x'.repeat(500), name: 'Long\u0000name' } },
  ],
};

/** A fake Overpass server whose behaviour each test can change. */
async function startFakeOverpass() {
  const state = { mode: 'ok', hits: 0, queries: [], userAgents: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits++;
      state.queries.push(new URLSearchParams(body).get('data'));
      state.userAgents.push(req.headers['user-agent']);
      if (state.mode === 'error') return res.writeHead(504).end('Gateway Timeout');
      if (state.mode === 'hang') return; // never answers
      res.writeHead(200, { 'content-type': 'application/json' });
      if (state.mode === 'remark') return res.end(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }));
      if (state.mode === 'huge') return res.end(JSON.stringify({ elements: [], pad: 'x'.repeat(200_000) }));
      if (state.mode === 'dense') {
        const elements = Array.from({ length: 10 }, (_, i) => ({ type: 'node', id: i + 1, lat: 52.515, lon: 13.375, tags: { amenity: 'bench' } }));
        return res.end(JSON.stringify({ elements }));
      }
      res.end(JSON.stringify(FIXTURE));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/interpreter`;
  return { state, url, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

async function startApp(overpassOverrides = {}, rateLimitOverrides = {}) {
  const base = loadConfig(TEST_ENV);
  const config = {
    ...base,
    rateLimits: { ...base.rateLimits, global: { windowMs: 60_000, limit: 10_000 }, osmApi: { windowMs: 60_000, limit: 1000 }, ...rateLimitOverrides },
    overpass: { ...base.overpass, timeoutMs: 1500, maxResponseBytes: 100_000, ...overpassOverrides },
  };
  const db = openDatabase(':memory:');
  const app = createApp({ config, db });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          app.locals.sessionStore.close();
          db.close();
          resolve();
        });
      }),
  };
}

describe('map page', () => {
  let fake, app;
  before(async () => {
    fake = await startFakeOverpass();
    app = await startApp({ endpoints: [fake.url] });
  });
  after(async () => {
    await app.close();
    await fake.close();
  });

  test('renders the map container and loads Leaflet from our own origin', async () => {
    const res = await fetch(`${app.base}/map`);
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /<div id="map" class="map"/);
    assert.match(page, /data-tile-url="https:\/\/tile.openstreetmap.org\/\{z\}\/\{x\}\/\{y\}.png"/);
    assert.match(page, /<script src="\/vendor\/leaflet\/leaflet.js" defer><\/script>/);
    assert.match(page, /<script src="\/js\/map.js" defer><\/script>/);
    assert.match(page, /id="category-list"/);
    assert.equal(res.headers.getSetCookie().length, 0, 'viewing the map must not create a session');
  });

  test('CSP allows only OSM tiles as a cross-origin resource', async () => {
    const csp = (await fetch(`${app.base}/map`)).headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' data: https:\/\/tile.openstreetmap.org;/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /connect-src 'self';/);
  });

  test('serves Leaflet and the map script', async () => {
    for (const path of ['/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/js/map.js']) {
      const res = await fetch(app.base + path);
      assert.equal(res.status, 200, path);
    }
    assert.equal((await fetch(`${app.base}/vendor/leaflet/../../package.json`)).status, 404);
  });
});

describe('OSM features API', () => {
  let fake, app;
  before(async () => {
    fake = await startFakeOverpass();
    app = await startApp({ endpoints: [fake.url], maxElements: 10 });
  });
  after(async () => {
    await app.close();
    await fake.close();
  });
  beforeEach(() => {
    fake.state.mode = 'ok';
  });

  const get = (bbox) => fetch(`${app.base}/api/osm/features?bbox=${encodeURIComponent(bbox)}`);

  test('returns normalized features for a valid bbox', async () => {
    const res = await get(BBOX);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(res.headers.getSetCookie().length, 0);
    const body = await res.json();

    assert.deepEqual(body.bbox, [52.51, 13.37, 52.52, 13.385], 'snapped outward to the grid');
    assert.equal(body.truncated, false);
    const ids = body.features.map((f) => f.id);
    assert.deepEqual(ids, [1, 2, 3, 4, 7]);
    assert.deepEqual(body.features[0].c, [['tourism', 'attraction'], ['historic', 'monument']]);
    assert.deepEqual(body.features[2].c, [['amenity', 'restaurant'], ['amenity', 'bar']], 'multi-values split; "no" ignored');
    assert.deepEqual([body.features[3].lat, body.features[3].lon], [52.514, 13.375], 'way uses its center');
    assert.equal(body.features[3].t, 'w');
    // Untrusted text is passed through as data (escaped client-side), but bounded and stripped of control chars.
    assert.equal(body.features[1].name, '<img src=x onerror=alert(1)>');
    assert.equal(body.features[4].c[0][1].length, 64);
    assert.equal(body.features[4].name, 'Long name');
  });

  test('sends a well-formed Overpass query with an identifying User-Agent', () => {
    const q = fake.state.queries.at(-1);
    assert.match(q, /^\[out:json\]\[timeout:\d+\]\[bbox:52\.5100,13\.3700,52\.5200,13\.3850\];/);
    assert.match(q, /nwr\["amenity"\];nwr\["shop"\];/);
    assert.match(fake.state.userAgents.at(-1), /^SecureNotes\//);
  });

  test('caches results: a nearby view inside the same grid cell does not hit Overpass again', async () => {
    const before = fake.state.hits;
    assert.equal((await get('52.5132,13.3705,52.5188,13.3825')).status, 200);
    assert.equal(fake.state.hits, before);
  });

  test('rejects malformed or malicious bbox values', async () => {
    for (const bad of [
      '',
      '1,2,3',
      '1,2,3,4,5',
      'a,b,c,d',
      '52.5,13.3,52.6,13.4);out;(',
      '52.5,13.3,52.6,13.4]',
      '1e1,2,3,4',
      '91,0,92,1',
      '52.6,13.3,52.5,13.4', // south > north
      '0x10,1,2,3',
    ]) {
      const res = await get(bad);
      assert.equal(res.status, 400, `bbox ${JSON.stringify(bad)}`);
      assert.equal(typeof (await res.json()).error, 'string');
    }
    const repeated = await fetch(`${app.base}/api/osm/features?bbox=${BBOX}&bbox=${BBOX}`);
    assert.equal(repeated.status, 400, 'repeated parameter');
  });

  test('refuses areas that are too large', async () => {
    const res = await get('52.0,13.0,53.0,14.0');
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /Zoom in/);
  });

  test('flags truncated results', async () => {
    fake.state.mode = 'dense';
    const body = await (await get('48.1,11.5,48.105,11.505')).json();
    assert.equal(body.truncated, true);
  });

  test('upstream failures return a generic 502 without internal details', async () => {
    for (const [mode, bbox] of [['error', '40.1,-3.7,40.105,-3.695'], ['remark', '41.1,2.1,41.105,2.105'], ['huge', '45.1,9.1,45.105,9.105'], ['hang', '50.1,8.6,50.105,8.605']]) {
      fake.state.mode = mode;
      const res = await get(bbox);
      assert.equal(res.status, 502, mode);
      const body = await res.json();
      assert.equal(body.error, 'Map data is temporarily unavailable. Please try again shortly.');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  });

  test('unknown API routes return JSON 404', async () => {
    const res = await fetch(`${app.base}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found.' });
  });
});

describe('Overpass failover and rate limiting', () => {
  test('falls back to the next endpoint when the first fails', async () => {
    const broken = await startFakeOverpass();
    const healthy = await startFakeOverpass();
    broken.state.mode = 'error';
    const app = await startApp({ endpoints: [broken.url, healthy.url] });
    try {
      const res = await fetch(`${app.base}/api/osm/features?bbox=${BBOX}`);
      assert.equal(res.status, 200);
      assert.equal(broken.state.hits, 1);
      assert.equal(healthy.state.hits, 1);
    } finally {
      await app.close();
      await broken.close();
      await healthy.close();
    }
  });

  test('the API is rate limited per client', async () => {
    const fake = await startFakeOverpass();
    const app = await startApp({ endpoints: [fake.url] }, { osmApi: { windowMs: 60_000, limit: 2 } });
    try {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await fetch(`${app.base}/api/osm/features?bbox=${BBOX}`)).status);
      assert.deepEqual(statuses, [200, 200, 429]);
    } finally {
      await app.close();
      await fake.close();
    }
  });
});

describe('bbox helpers', () => {
  test('parse, snap and measure', () => {
    const { bbox } = parseBbox('52.51301,13.37012,52.51899,13.38288');
    assert.deepEqual(snapBbox(bbox), { south: 52.51, west: 13.37, north: 52.52, east: 13.385 });
    assert.ok(Math.abs(bboxArea(snapBbox(bbox)) - 0.00015) < 1e-9);
    assert.ok(parseBbox('-33.9,151.1,-33.8,151.3').bbox);
    assert.ok(parseBbox('1,2').error);
  });

  test('query contains only validated numbers and fixed keys', () => {
    const q = buildQuery({ south: 1, west: 2, north: 3, east: 4 }, { maxElements: 100, timeoutSeconds: 20 });
    assert.equal(
      q,
      '[out:json][timeout:20][bbox:1.0000,2.0000,3.0000,4.0000];' +
        '(nwr["amenity"];nwr["shop"];nwr["tourism"];nwr["leisure"];nwr["historic"];nwr["office"];nwr["craft"];nwr["healthcare"];nwr["emergency"];nwr["public_transport"];)->.poi;' +
        'node.poi;out qt 100;(way.poi;relation.poi;);out tags center qt 100;',
    );
  });

  test('normalizer ignores junk', () => {
    assert.deepEqual(normalizeElements(null), []);
    assert.deepEqual(normalizeElements([{ type: 'node', id: -1, lat: 1, lon: 1, tags: { amenity: 'x' } }, { type: 'evil', id: 1, lat: 1, lon: 1, tags: { amenity: 'x' } }, { type: 'node', id: 2, lat: 999, lon: 1, tags: { amenity: 'x' } }]), []);
  });
});

describe('map config', () => {
  test('rejects insecure or malformed service URLs', () => {
    assert.throws(() => loadConfig({ ...TEST_ENV, OVERPASS_URLS: 'http://example.com/api' }), /https/);
    assert.throws(() => loadConfig({ ...TEST_ENV, OVERPASS_URLS: 'https://user:pw@example.com/api' }), /credentials/);
    assert.throws(() => loadConfig({ ...TEST_ENV, MAP_TILE_URL: 'https://tiles.example.com/x.png' }), /\{z\}/);
    assert.throws(() => loadConfig({ ...TEST_ENV, MAP_DEFAULT_VIEW: '52,13,40' }), /zoom/);
    assert.equal(loadConfig({ ...TEST_ENV, OVERPASS_URLS: 'http://127.0.0.1:9999/api' }).overpass.endpoints[0], 'http://127.0.0.1:9999/api');
  });
});
