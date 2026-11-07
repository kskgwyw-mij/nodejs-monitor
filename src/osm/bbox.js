// Bounding boxes are snapped outward to this grid (~550 m) so that small pans
// reuse cached results, and so cache keys can't be varied endlessly.
export const GRID_DEGREES = 0.005;

// Largest area we'll query (in square degrees, after snapping). Roughly a
// zoom-15 view on a large monitor; anything bigger asks the user to zoom in.
export const MAX_AREA_SQ_DEGREES = 0.02;

const NUMBER_RE = /^-?\d{1,3}(?:\.\d{1,7})?$/;

/**
 * Parses "south,west,north,east". Returns { bbox } or { error } — never throws.
 */
export function parseBbox(raw) {
  if (typeof raw !== 'string' || raw.length > 100) return { error: 'Missing or invalid bbox parameter.' };
  const parts = raw.split(',');
  if (parts.length !== 4 || !parts.every((p) => NUMBER_RE.test(p))) {
    return { error: 'bbox must be four numbers: south,west,north,east.' };
  }
  const [south, west, north, east] = parts.map(Number);
  if (south < -90 || north > 90 || west < -180 || east > 180) return { error: 'bbox is out of range.' };
  if (south >= north || west >= east) return { error: 'bbox must have south < north and west < east.' };
  return { bbox: { south, west, north, east } };
}

const snapDown = (v) => Math.floor(v / GRID_DEGREES + 1e-9) * GRID_DEGREES;
const snapUp = (v) => Math.ceil(v / GRID_DEGREES - 1e-9) * GRID_DEGREES;
const round4 = (v) => Math.round(v * 1e4) / 1e4;

export function snapBbox({ south, west, north, east }) {
  return {
    south: round4(Math.max(-90, snapDown(south))),
    west: round4(Math.max(-180, snapDown(west))),
    north: round4(Math.min(90, snapUp(north))),
    east: round4(Math.min(180, snapUp(east))),
  };
}

export const bboxArea = ({ south, west, north, east }) => (north - south) * (east - west);
