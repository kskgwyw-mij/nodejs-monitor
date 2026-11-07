import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { bboxArea, MAX_AREA_SQ_DEGREES, parseBbox, snapBbox } from '../osm/bbox.js';
import { CATEGORY_KEYS } from '../osm/overpass.js';
import { mapPage } from '../views/pages.js';
import { render } from '../views/render.js';
import { html } from '../views/html.js';

const jsonError = (res, status, error) => res.status(status).set('Cache-Control', 'no-store').json({ error });

/**
 * JSON API: GET /api/osm/features?bbox=south,west,north,east
 * Mounted before the session middleware, so it never creates sessions.
 */
export function osmApiRouter({ overpass, rateLimit: limits }) {
  const router = Router();

  router.use(
    rateLimit({
      ...limits,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (req, res) => jsonError(res, 429, 'Too many requests. Please slow down.'),
    }),
  );

  router.get('/osm/features', async (req, res) => {
    const { bbox, error } = parseBbox(req.query.bbox);
    if (error) return jsonError(res, 400, error);

    const snapped = snapBbox(bbox);
    if (bboxArea(snapped) > MAX_AREA_SQ_DEGREES + 1e-9) {
      return jsonError(res, 422, 'Area too large. Zoom in to load map data.');
    }

    try {
      const result = await overpass.features(snapped);
      res.set('Cache-Control', 'public, max-age=300');
      res.json({
        bbox: [snapped.south, snapped.west, snapped.north, snapped.east],
        keys: CATEGORY_KEYS,
        truncated: result.truncated,
        fetchedAt: result.fetchedAt,
        features: result.features,
      });
    } catch (err) {
      if (err.busy) return jsonError(res, 503, 'The map data service is busy. Please try again in a moment.');
      if (err.name !== 'OverpassError') console.error(err);
      jsonError(res, 502, 'Map data is temporarily unavailable. Please try again shortly.');
    }
  });

  // Unknown API routes: JSON 404 instead of an HTML page.
  router.use((req, res) => jsonError(res, 404, 'Not found.'));
  return router;
}

/** The HTML map page (mounted after sessions, so the nav knows who is signed in). */
export function mapPageRouter({ mapConfig }) {
  const router = Router();
  router.get('/map', (req, res) => {
    render(req, res, {
      title: 'Map',
      wide: true,
      head: html`<link rel="stylesheet" href="/vendor/leaflet/leaflet.css">`,
      scripts: html`<script src="/vendor/leaflet/leaflet.js" defer></script>
  <script src="/js/map.js" defer></script>`,
      content: mapPage(mapConfig),
    });
  });
  return router;
}
