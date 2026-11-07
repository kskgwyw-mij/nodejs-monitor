import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { hashPassword, needsRehash, verifyPassword } from '../src/security/passwords.js';
import { html } from '../src/views/html.js';

const TEST_ENV = { NODE_ENV: 'test', SESSION_SECRET: 'test-secret-'.padEnd(48, 'x'), LOG_REQUESTS: 'false' };
const PASSWORD = 'correct horse battery staple';

const RELAXED_LIMITS = {
  global: { windowMs: 60_000, limit: 10_000 },
  login: { windowMs: 60_000, limit: 1_000 },
  register: { windowMs: 60_000, limit: 1_000 },
};

async function startServer(overrides = {}, env = TEST_ENV) {
  const config = { ...loadConfig(env), rateLimits: RELAXED_LIMITS, ...overrides };
  const db = openDatabase(':memory:');
  const app = createApp({ config, db });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        app.locals.sessionStore.close();
        db.close();
        resolve();
      });
    });
  return { base, close, db };
}

/** Minimal browser-like client with a cookie jar and manual redirects. */
class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.lastSetCookies = [];
  }

  async request(path, { method = 'GET', form, rawBody, headers = {} } = {}) {
    const h = { 'sec-fetch-site': 'same-origin', ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form || rawBody) {
      body = rawBody ?? new URLSearchParams(form).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(this.base + path, { method, headers: h, body, redirect: 'manual' });
    this.lastSetCookies = res.headers.getSetCookie();
    for (const c of this.lastSetCookies) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const [name, value] = [pair.slice(0, i), pair.slice(i + 1)];
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    res.body_ = await res.text();
    return res;
  }

  async csrfFrom(path) {
    const res = await this.request(path);
    const match = res.body_.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(match, `no CSRF token on ${path}`);
    return match[1];
  }

  async register(username, password = PASSWORD) {
    const _csrf = await this.csrfFrom('/register');
    return this.request('/register', { method: 'POST', form: { _csrf, username, password } });
  }

  async login(username, password = PASSWORD) {
    const _csrf = await this.csrfFrom('/login');
    return this.request('/login', { method: 'POST', form: { _csrf, username, password } });
  }
}

describe('website', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv.close());

  test('home page sends hardened security headers', async () => {
    const res = await new Client(srv.base).request('/');
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('anonymous pages and health checks do not create sessions', async () => {
    const c = new Client(srv.base);
    await c.request('/');
    await c.request('/healthz');
    await c.request('/css/styles.css');
    assert.equal(c.cookies.size, 0);
  });

  test('static assets are served, dotfiles and directory listings are not', async () => {
    const c = new Client(srv.base);
    assert.equal((await c.request('/css/styles.css')).status, 200);
    assert.equal((await c.request('/css/')).status, 404);
    assert.equal((await c.request('/.env')).status, 404);
  });

  test('session cookie is HttpOnly and SameSite=Lax', async () => {
    const c = new Client(srv.base);
    await c.request('/login');
    const cookie = c.lastSetCookies.find((s) => s.startsWith('sid='));
    assert.ok(cookie, 'session cookie set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
  });

  test('POST without a CSRF token is rejected', async () => {
    const c = new Client(srv.base);
    await c.request('/register'); // get a session, but don't send its token
    const res = await c.request('/register', { method: 'POST', form: { username: 'mallory', password: PASSWORD } });
    assert.equal(res.status, 403);
  });

  test('cross-site POST is rejected even with a valid token', async () => {
    const c = new Client(srv.base);
    const _csrf = await c.csrfFrom('/register');
    const res = await c.request('/register', {
      method: 'POST',
      form: { _csrf, username: 'mallory', password: PASSWORD },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 403);
  });

  test('register -> notes -> logout -> login flow, with session ID rotation', async () => {
    const c = new Client(srv.base);
    await c.request('/register');
    const anonSid = c.cookies.get('sid');

    const reg = await c.register('alice');
    assert.equal(reg.status, 303);
    assert.equal(reg.headers.get('location'), '/notes');
    assert.notEqual(c.cookies.get('sid'), anonSid, 'session ID must change on login (fixation)');

    const notes = await c.request('/notes');
    assert.equal(notes.status, 200);
    assert.match(notes.body_, /Signed in as <strong>alice<\/strong>/);

    const _csrf = notes.body_.match(/name="_csrf" value="([^"]+)"/)[1];
    const out = await c.request('/logout', { method: 'POST', form: { _csrf } });
    assert.equal(out.status, 303);

    const after = await c.request('/notes');
    assert.equal(after.status, 303);
    assert.equal(after.headers.get('location'), '/login');

    const login = await c.login('ALICE'); // usernames are case-insensitive
    assert.equal(login.status, 303);
    assert.equal((await c.request('/notes')).status, 200);
  });

  test('logout requires POST (GET does nothing)', async () => {
    const c = new Client(srv.base);
    await c.register('gina');
    assert.equal((await c.request('/logout')).status, 404);
    assert.equal((await c.request('/notes')).status, 200);
  });

  test('login errors are generic and do not reveal whether a user exists', async () => {
    const c = new Client(srv.base);
    await c.register('bob');
    const anon = new Client(srv.base);
    const wrongPw = await anon.login('bob', 'not the right password');
    const noUser = await anon.login('nobody-here', 'not the right password');
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.match(wrongPw.body_, /Incorrect username or password/);
    assert.match(noUser.body_, /Incorrect username or password/);
  });

  test('registration validates input', async () => {
    const c = new Client(srv.base);
    assert.equal((await c.register('carol', 'short')).status, 422);
    assert.equal((await c.register('carol', 'password1234')).status, 422); // common password
    assert.equal((await c.register('carol', 'carol-is-great-123')).status, 422); // contains username
    assert.equal((await c.register('<script>', PASSWORD)).status, 422);
    assert.equal((await c.register('CaRoL')).status, 303);
    assert.equal((await new Client(srv.base).register('carol')).status, 409); // duplicate, case-insensitive
  });

  test('duplicated form fields (parameter pollution) are rejected safely', async () => {
    const c = new Client(srv.base);
    const _csrf = await c.csrfFrom('/register');
    const rawBody = `_csrf=${encodeURIComponent(_csrf)}&username=dave&username=eve&password=${encodeURIComponent(PASSWORD)}`;
    const res = await c.request('/register', { method: 'POST', rawBody });
    assert.equal(res.status, 422);
  });

  test('user content is HTML-escaped (stored XSS)', async () => {
    const c = new Client(srv.base);
    await c.register('erin');
    const _csrf = await c.csrfFrom('/notes');
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const res = await c.request('/notes', { method: 'POST', form: { _csrf, title: payload, body: `"'>${payload}` } });
    assert.equal(res.status, 303);
    const page = (await c.request('/notes')).body_;
    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.ok(!page.includes('<img src=x'));
    assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  test("users cannot delete each other's notes (IDOR)", async () => {
    const owner = new Client(srv.base);
    await owner.register('frank');
    let _csrf = await owner.csrfFrom('/notes');
    await owner.request('/notes', { method: 'POST', form: { _csrf, title: 'secret plan', body: 'keep out' } });
    const id = (await owner.request('/notes')).body_.match(/action="\/notes\/(\d+)\/delete"/)[1];

    const attacker = new Client(srv.base);
    await attacker.register('mallory');
    _csrf = await attacker.csrfFrom('/notes');
    const res = await attacker.request(`/notes/${id}/delete`, { method: 'POST', form: { _csrf } });
    assert.equal(res.status, 404);
    assert.ok(!(await attacker.request('/notes')).body_.includes('secret plan'));
    assert.ok((await owner.request('/notes')).body_.includes('secret plan'));

    const bad = await attacker.request('/notes/1%20OR%201=1/delete', { method: 'POST', form: { _csrf } });
    assert.equal(bad.status, 404);
  });

  test('oversized request bodies are rejected', async () => {
    const c = new Client(srv.base);
    const res = await c.request('/login', { method: 'POST', rawBody: `x=${'a'.repeat(32 * 1024)}` });
    assert.equal(res.status, 413);
  });

  test('unknown routes return a generic 404 without internals', async () => {
    const res = await new Client(srv.base).request('/does-not-exist');
    assert.equal(res.status, 404);
    assert.ok(!/node_modules|at .+\.js:\d+/.test(res.body_));
  });
});

describe('rate limiting', () => {
  test('repeated failed logins are throttled', async () => {
    const srv = await startServer({ rateLimits: { ...RELAXED_LIMITS, login: { windowMs: 60_000, limit: 3 } } });
    try {
      const c = new Client(srv.base);
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await c.login('nobody', 'wrong password!!')).status);
      assert.deepEqual(statuses, [401, 401, 401, 429]);
    } finally {
      await srv.close();
    }
  });
});

describe('production mode', () => {
  test('enables HSTS and upgrade-insecure-requests', async () => {
    const srv = await startServer({}, { ...TEST_ENV, NODE_ENV: 'production' });
    try {
      const res = await fetch(`${srv.base}/`);
      assert.match(res.headers.get('strict-transport-security'), /max-age=31536000; includeSubDomains/);
      assert.match(res.headers.get('content-security-policy'), /upgrade-insecure-requests/);
    } finally {
      await srv.close();
    }
  });
});

describe('config', () => {
  test('refuses to start in production without a strong session secret', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SESSION_SECRET is required/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short' }), /at least 32/);
  });

  test('refuses TRUST_PROXY=true', () => {
    assert.throws(() => loadConfig({ ...TEST_ENV, TRUST_PROXY: 'true' }), /unsafe/);
    assert.equal(loadConfig({ ...TEST_ENV, TRUST_PROXY: '1' }).trustProxy, 1);
  });
});

describe('passwords', () => {
  test('hash and verify', async () => {
    const hash = await hashPassword(PASSWORD);
    assert.match(hash, /^scrypt\$32768\$8\$3\$/);
    assert.equal(await verifyPassword(PASSWORD, hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
    assert.notEqual(hash, await hashPassword(PASSWORD), 'salted');
    assert.equal(needsRehash(hash), false);
  });

  test('malformed or tampered hashes never verify', async () => {
    assert.equal(await verifyPassword(PASSWORD, ''), false);
    assert.equal(await verifyPassword(PASSWORD, 'scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'), false);
    assert.equal(await verifyPassword(PASSWORD, 'md5$abc'), false);
  });
});

describe('html templating', () => {
  test('escapes interpolated values but keeps nested templates', () => {
    const name = `<b onclick="x">'&`;
    const out = html`<p title="${name}">${name}${html`<i>ok</i>`}</p>`.toString();
    assert.equal(out, '<p title="&lt;b onclick=&quot;x&quot;&gt;&#39;&amp;">&lt;b onclick=&quot;x&quot;&gt;&#39;&amp;<i>ok</i></p>');
  });
});
