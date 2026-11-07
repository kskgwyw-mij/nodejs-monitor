import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import helmet from 'helmet';
import { HttpError } from './errors.js';
import { loadUser } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { mapPageRouter, osmApiRouter } from './routes/map.js';
import { notesRouter } from './routes/notes.js';
import { OverpassClient } from './osm/overpass.js';
import { csrfProtection } from './security/csrf.js';
import { SQLiteSessionStore } from './session-store.js';
import { errorPage, homePage } from './views/pages.js';
import { render } from './views/render.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
// Leaflet is served from our own origin (no third-party script CDN).
const LEAFLET_DIR = dirname(fileURLToPath(import.meta.resolve('leaflet/dist/leaflet.js')));

function securityHeaders(config) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        // Map tiles are the only cross-origin resource the page loads. `data:` is needed
        // because Leaflet cancels in-flight tiles by swapping in a 1x1 data: GIF.
        imgSrc: ["'self'", 'data:', config.map.tileOrigin],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        ...(config.secureCookies ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS only makes sense (and is only honoured) when served over HTTPS.
    strictTransportSecurity: config.secureCookies ? { maxAge: 31536000, includeSubDomains: true } : false,
    xFrameOptions: { action: 'deny' },
  });
}

function permissionsPolicy(req, res, next) {
  res.set(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()',
  );
  next();
}

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // Log the path only: query strings can contain tokens or personal data.
    console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}

function limiter({ windowMs, limit }, extra = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) => next(new HttpError(429, 'Too many requests. Please wait a while and try again.')),
    ...extra,
  });
}

export function createApp({ config, db, overpass = new OverpassClient(config.overpass) }) {
  const app = express();
  const cookieName = config.secureCookies ? '__Host-sid' : 'sid';
  const sessionStore = new SQLiteSessionStore(db, { defaultTtlMs: config.session.idleTimeoutMs });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');

  if (config.logRequests) app.use(requestLogger);
  app.use(securityHeaders(config));
  app.use(permissionsPolicy);

  // Health check: before sessions, so probes never create sessions.
  app.get('/healthz', (req, res) => res.type('text').set('Cache-Control', 'no-store').send('ok'));

  const staticOptions = { dotfiles: 'ignore', index: false, redirect: false, maxAge: config.isProduction ? '1d' : 0 };
  app.use(express.static(PUBLIC_DIR, staticOptions));
  app.use('/vendor/leaflet', express.static(LEAFLET_DIR, staticOptions));

  // Everything below is dynamic and may be personalised: never cache it.
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(limiter(config.rateLimits.global));

  // Public JSON API for map data: before sessions/body parsing, so it never creates sessions.
  app.use('/api', osmApiRouter({ overpass, rateLimit: config.rateLimits.osmApi }));

  // Small body limits: these forms never need more than a few KB.
  app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 }));

  app.use(
    session({
      name: cookieName,
      secret: config.sessionSecrets,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true, // idle timeout: expiry is pushed forward on each request
      unset: 'destroy',
      cookie: {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'lax',
        path: '/',
        maxAge: config.session.idleTimeoutMs,
      },
    }),
  );

  app.use(loadUser({ db, absoluteTimeoutMs: config.session.absoluteTimeoutMs }));
  app.use(csrfProtection());

  const limiters = {
    login: limiter(config.rateLimits.login, { skipSuccessfulRequests: true }),
    register: limiter(config.rateLimits.register),
  };

  app.get('/', (req, res) => render(req, res, { title: 'Home', content: homePage({ user: req.user }) }));
  app.use(mapPageRouter({ mapConfig: config.map }));
  app.use(authRouter({ db, limiters, cookieName }));
  app.use(notesRouter({ db }));

  // 404
  app.use((req, res, next) => next(new HttpError(404, "We couldn't find that page.")));

  // Central error handler: never leak stack traces or internal messages to clients.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    let message = 'Something went wrong on our side. Please try again later.';

    if (err.expose && err instanceof HttpError) {
      message = err.message;
    } else if (err.type === 'entity.too.large') {
      message = 'That request was too large.';
    } else if (status >= 400 && status < 500) {
      message = 'That request could not be processed.';
    } else {
      status = 500;
      console.error(err);
    }

    if (res.headersSent) return req.socket.destroy();
    res.set('Cache-Control', 'no-store');
    render(req, res, { status, title: `Error ${status}`, content: errorPage({ status, message }) });
  });

  app.locals.sessionStore = sessionStore;
  return app;
}
