# nodejs-monitor

**SecureNotes** is a small, security-hardened website (sign-up, sign-in, private notes and an
OpenStreetMap map that lists the OSM categories in view) built on
**Node.js 25**, **Express 5** and Node's built-in **SQLite** driver. It is meant as a
solid starting point: secure defaults everywhere, very few dependencies, and a
test suite that checks the security behaviour.

| Tool    | Version   |
|---------|-----------|
| Node.js | 25.9.0 (`.nvmrc`; `engines` requires 25.x) |
| npm     | 11.6.2    |
| yarn    | 1.22.22 (`packageManager`) |

Runtime dependencies (pinned exactly): `express`, `helmet`, `express-session`,
`express-rate-limit`, and `leaflet` (served to the browser from our own origin). Everything else (password hashing, SQLite, templating, CSRF,
tests) uses Node built-ins.

## Map: OpenStreetMap categories in view

`/map` shows an interactive OpenStreetMap map. Below it, the site lists the OSM categories
of every place in the visible area, grouped by top-level key: `amenity`, `shop`, `tourism`,
`leisure`, `historic`, `office`, `craft`, `healthcare`, `emergency` and `public_transport`.
Each group shows its values with counts. Clicking a value highlights those places on the map,
and each highlighted place has a popup with its name and a link to openstreetmap.org. The view
is kept in the URL (`#map=zoom/lat/lon`), so map links can be shared.

How it works:

```
browser (Leaflet, served from /vendor)  ──tiles──▶  tile.openstreetmap.org
        │ GET /api/osm/features?bbox=…
        ▼
Node server: validate bbox → snap to ~550 m grid → cache (10 min) → Overpass API (POST, 25 s timeout)
```

- The browser only calls our own API, so the CSP stays `connect-src 'self'`.
- The server snaps the box to a grid, caches results and de-duplicates identical requests.
  It runs at most 2 Overpass queries at a time and fails over between `OVERPASS_URLS`.
  The client counts categories for the *exact* visible area and recounts on every pan without
  another request.
- Categories load from **zoom 15** upwards, and the server refuses areas larger than 0.02 deg².
  In very dense areas, results are capped at 5,000 elements per type and the page says so.

Map security notes:
- **Untrusted data.** OSM names and tags are user-generated. The server strips control
  characters and limits their length. The browser only inserts them with `textContent` or DOM
  nodes, never `innerHTML`; popups are DOM elements.
- **Query injection.** Only validated numbers and a fixed key list are put into the
  Overpass query.
- **Overpass requests.** The server ignores redirects, caps responses at 15 MB, and returns
  a generic 502 instead of upstream error details.
- **CSP.** The only cross-origin resource is the tile server
  (`img-src 'self' data: https://tile.openstreetmap.org`). Leaflet is served from our own origin.
- **Tile policy.** Tiles load with `crossorigin` to satisfy our Cross-Origin-Embedder-Policy,
  and with `referrerpolicy="strict-origin-when-cross-origin"`. OSM's tile policy requires a
  Referer, while the rest of the site stays `no-referrer`.
- **Rate limits.** The API allows 30 requests per minute per IP, and never creates sessions.

**Usage policies:** the public OSM tile server and Overpass instances are free but have
[tile](https://operations.osmfoundation.org/policies/tiles/) and
[Overpass](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html) fair-use policies.
For a busy site, set `OVERPASS_USER_AGENT` with your contact details, and consider a commercial
tile provider (`MAP_TILE_URL`) or your own Overpass instance (`OVERPASS_URLS`).
Attribution "© OpenStreetMap contributors" is required and shown on the page.

## Quick start

```bash
yarn install --frozen-lockfile      # or: npm ci
cp .env.example .env                 # then set SESSION_SECRET (see below)
yarn dev                             # http://127.0.0.1:3000, restarts on change
```

Generate a session secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

| Script        | What it does |
|---------------|--------------|
| `yarn dev`    | Development server with `--watch` (HTTP, non-Secure cookies, random secret if unset). |
| `yarn start`  | Production start under Node's **permission model** (see below). |
| `yarn test`   | Runs the `node:test` suite (39 tests: headers, CSRF, XSS, IDOR, rate limits, sessions, map API with a fake Overpass server, ...). |
| `yarn audit`  | `npm audit` + `yarn audit` of production dependencies. |

All scripts work the same with `npm run <script>`. Both `yarn.lock` and
`package-lock.json` are committed and pinned to identical versions.

## Security features

**HTTP & browser**
- Strict Content-Security-Policy: `default-src 'none'`, scripts/styles only from self, no inline script, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.
- Helmet headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/COEP/CORP, and HSTS (1 year) + `upgrade-insecure-requests` when served over HTTPS.
- `Permissions-Policy` disables camera, microphone, geolocation, payment, USB, and so on.
- `Cache-Control: no-store` on all dynamic pages; `X-Powered-By` removed.

**Authentication & sessions**
- Passwords hashed with **scrypt** (OWASP profile N=2¹⁵, r=8, p=3), random salts, constant-time comparison, NFKC normalisation, transparent re-hashing when parameters are raised.
- NIST-style password policy: 12–128 characters, no composition rules, rejects common passwords and passwords containing the username.
- Login errors are generic, and a dummy hash is checked for unknown users, so neither the response nor its timing reveals whether an account exists.
- Session ID regenerated on login (prevents session fixation). Logout is POST-only, destroys the server-side session and clears the cookie.
- Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` with the `__Host-` prefix in production/HTTPS.
- 2-hour idle timeout plus 12-hour absolute timeout.
- Sessions live in SQLite with **hashed session IDs**, so a leaked DB can't be used to hijack sessions. Anonymous visitors only get a session once a page renders a form.

**Request handling**
- CSRF: per-session synchronizer token on every state-changing request, **plus** a Fetch Metadata check (`Sec-Fetch-Site`) that rejects cross-site requests.
- Rate limits: global (600 / 15 min / IP), failed logins (10 / 15 min / IP), sign-ups (10 / hour / IP).
- Body size capped at 16 KB with at most 20 form fields; repeated fields (parameter pollution) are rejected.
- Server timeouts against slow clients (headers 15 s, full request 30 s) and a header count limit.
- Central error handler: generic messages only, so no stack traces or internals reach clients.

**Data**
- Every SQL statement is prepared with bound parameters; SQLite extension loading is disabled.
- Every notes query is scoped to the signed-in user (IDOR-safe; another user's note returns 404).
- All output goes through an auto-escaping `html` template tag (`src/views/html.js`).
- Data files are created with `0600` permissions (`umask 077`); `PRAGMA secure_delete` is on.

**Runtime & supply chain**
- `yarn start` / Docker run Node with `--permission`: it can only read the app directory and write `./data`. It cannot spawn processes, start workers or load native addons.
- `.npmrc`/`.yarnrc`: install scripts disabled, exact versions, `engine-strict`.
- Dependencies pinned exactly. Releases younger than about two weeks were deliberately avoided.
- Config fails fast: production refuses to start without a ≥32-char `SESSION_SECRET`, and `TRUST_PROXY=true` (spoofable client IPs) is rejected.

## Configuration

See [`.env.example`](.env.example). The important settings:

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables Secure cookies, HSTS, required secret. |
| `SESSION_SECRET` | – | Required in production. Comma-separate to rotate (new first). |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | |
| `DATABASE_PATH` | `./data/app.db` | |
| `TRUST_PROXY` | off | Number of reverse-proxy hops (e.g. `1`) when behind nginx/Caddy/a load balancer. |
| `OVERPASS_URLS` | `https://overpass-api.de/api/interpreter` | Comma-separated Overpass endpoints, tried in order (https only). |
| `OVERPASS_USER_AGENT` | `SecureNotes/1.0 (...)` | Identify your site to Overpass. |
| `MAP_DEFAULT_VIEW` | `52.5163,13.3777,16` | Initial `lat,lon,zoom` of the map. |
| `MAP_TILE_URL` | OSM standard tiles | Must contain `{z}`, `{x}`, `{y}`. Its origin is added to the CSP automatically. |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | – | Serve HTTPS directly from Node (TLS ≥ 1.2). With `yarn start`, they must be inside the project directory (permission model). |

## Deploying

Production must be served over **HTTPS**, because Secure cookies are not sent over plain HTTP.
You have two options:
1. **Reverse proxy (recommended):** nginx/Caddy terminates TLS and forwards to `127.0.0.1:3000`; set `TRUST_PROXY=1`.
2. **Direct TLS:** set `TLS_CERT_FILE` and `TLS_KEY_FILE`.

Docker (written but **not build-tested here**, because no Docker daemon was available):

```bash
docker build -t securenotes .
```

```bash
docker run -d -p 127.0.0.1:3000:3000 -e SESSION_SECRET=... -e TRUST_PROXY=1 -v securenotes-data:/app/data --read-only --cap-drop=ALL --security-opt=no-new-privileges securenotes
```

The image runs as the unprivileged `node` user, keeps the code root-owned (read-only to the app), strips npm/yarn from the runtime, and applies the same permission-model flags.

### Production checklist
- [ ] Strong `SESSION_SECRET` from a secret manager, not committed.
- [ ] HTTPS only; consider HSTS preload once you're sure.
- [ ] `TRUST_PROXY` matches your real proxy chain.
- [ ] Rate limits use in-memory storage, so they are per process. With multiple instances, use a shared store (e.g. Redis via `rate-limit-redis`).
- [ ] Back up `data/app.db` (use SQLite's `.backup`, not a raw file copy, while the app runs).
- [ ] Run `yarn audit` in CI, and keep Node 25.x patched. Node 25 is an odd-numbered "Current" line, so plan a move to an LTS line for long-lived production.

## Note on `--allow-net`

Node 25 prints `ExperimentalWarning: The flag --allow-net is under experimental phase`.
This is expected. The flag lets the permission-restricted process open its listening socket.
