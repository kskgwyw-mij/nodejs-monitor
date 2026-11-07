'use strict';

/*
 * OpenStreetMap viewer: shows an OSM map and lists the OSM categories
 * (amenity=*, shop=*, tourism=*, ...) of everything inside the visible area.
 *
 * Security notes:
 *  - All OSM-provided text (names, tag values) is untrusted user content. It is
 *    only ever inserted with textContent / DOM nodes, never innerHTML.
 *  - Data comes from our own /api endpoint (CSP connect-src 'self').
 */
(() => {
  const mapEl = document.getElementById('map');
  if (!mapEl || typeof L === 'undefined') return;

  const statusEl = document.getElementById('map-status');
  const listEl = document.getElementById('category-list');
  const clearBtn = document.getElementById('clear-selection');

  const cfg = {
    lat: Number(mapEl.dataset.lat),
    lon: Number(mapEl.dataset.lon),
    zoom: Number(mapEl.dataset.zoom),
    minDataZoom: Number(mapEl.dataset.minDataZoom),
    tileUrl: mapEl.dataset.tileUrl,
  };

  const KEY_INFO = {
    amenity: { label: 'Amenities', color: '#d9480f' },
    shop: { label: 'Shops', color: '#7048e8' },
    tourism: { label: 'Tourism', color: '#1971c2' },
    leisure: { label: 'Leisure', color: '#2f9e44' },
    historic: { label: 'Historic', color: '#9c5a2b' },
    office: { label: 'Offices', color: '#5c677d' },
    craft: { label: 'Crafts', color: '#c77700' },
    healthcare: { label: 'Healthcare', color: '#c2255c' },
    emergency: { label: 'Emergency', color: '#e03131' },
    public_transport: { label: 'Public transport', color: '#0c8599' },
  };
  const VISIBLE_CHIPS = 12;
  const MAX_MARKERS = 2000;
  const OSM_TYPES = { n: 'node', w: 'way', r: 'relation' };

  const humanize = (value) => value.replace(/_/g, ' ');
  const keyInfo = (key) => KEY_INFO[key] ?? { label: humanize(key), color: '#868e96' };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('aria-') || k.startsWith('data-')) node.setAttribute(k, v);
      else node[k] = v;
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  // ---------- Map ----------
  function viewFromHash() {
    const m = /^#map=(\d{1,2})\/(-?\d{1,2}(?:\.\d{1,7})?)\/(-?\d{1,3}(?:\.\d{1,7})?)$/.exec(location.hash);
    if (!m) return null;
    const [zoom, lat, lon] = m.slice(1).map(Number);
    if (zoom < 2 || zoom > 19 || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
    return { zoom, lat, lon };
  }

  const start = viewFromHash() ?? cfg;
  const map = L.map(mapEl, { center: [start.lat, start.lon], zoom: start.zoom, minZoom: 2, maxZoom: 19 });

  L.tileLayer(cfg.tileUrl, {
    maxZoom: 19,
    crossOrigin: 'anonymous', // needed with our Cross-Origin-Embedder-Policy
    referrerPolicy: 'strict-origin-when-cross-origin', // OSM's tile policy requires a Referer
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const highlightLayer = L.layerGroup().addTo(map);

  function updateHash() {
    const c = map.getCenter();
    const z = map.getZoom();
    const precision = Math.max(0, Math.ceil(Math.log10(2 ** z)) - 1) + 1;
    history.replaceState(null, '', `#map=${z}/${c.lat.toFixed(precision)}/${c.lng.toFixed(precision)}`);
  }

  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (v) map.setView([v.lat, v.lon], v.zoom);
  });

  // ---------- State ----------
  let data = null; // last API response
  let controller = null;
  let requestSeq = 0;
  const selected = new Set(); // "key=value"

  const covers = (bbox, bounds) =>
    bbox[0] <= bounds.getSouth() && bbox[1] <= bounds.getWest() && bbox[2] >= bounds.getNorth() && bbox[3] >= bounds.getEast();

  function setStatus(text, state = '', action = null) {
    statusEl.replaceChildren(document.createTextNode(text));
    if (action) statusEl.append(' ', action);
    statusEl.dataset.state = state;
  }

  // ---------- Data loading ----------
  async function refresh() {
    updateHash();
    const zoom = map.getZoom();
    if (zoom < cfg.minDataZoom) {
      listEl.replaceChildren();
      highlightLayer.clearLayers();
      setStatus(`Zoom in to see categories (zoom level ${cfg.minDataZoom} or closer needed; currently ${zoom}).`, 'hint');
      return;
    }

    const view = map.wrapLatLngBounds(map.getBounds());
    if (data && covers(data.bbox, view)) {
      renderAll();
      return;
    }

    const s = clamp(view.getSouth(), -90, 90);
    const w = clamp(view.getWest(), -180, 180);
    const n = clamp(view.getNorth(), -90, 90);
    const e = clamp(view.getEast(), -180, 180);
    if (w >= e) {
      setStatus('This view crosses the date line. Pan a little to load data.', 'hint');
      return;
    }

    controller?.abort();
    controller = new AbortController();
    const seq = ++requestSeq;
    setStatus('Loading OpenStreetMap data…', 'loading');

    try {
      const bbox = [s, w, n, e].map((v) => v.toFixed(5)).join(',');
      const res = await fetch(`/api/osm/features?bbox=${encodeURIComponent(bbox)}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${res.status}).`);
      if (seq !== requestSeq) return;
      data = body;
      renderAll();
    } catch (err) {
      if (err.name === 'AbortError' || seq !== requestSeq) return;
      const retry = el('button', { type: 'button', class: 'link', text: 'Try again' });
      retry.addEventListener('click', () => {
        data = null;
        refresh();
      });
      setStatus(err.message || 'Could not load map data.', 'error', retry);
    }
  }

  let debounceTimer;
  map.on('moveend', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 350);
  });

  // ---------- Rendering ----------
  function renderAll() {
    const view = map.wrapLatLngBounds(map.getBounds());
    const visible = data.features.filter((f) => view.contains([f.lat, f.lon]));

    // key -> { places: number, values: Map(value -> count) }
    const groups = new Map();
    for (const f of visible) {
      const seenKeys = new Set();
      for (const [key, value] of f.c) {
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { places: 0, values: new Map() }));
        g.values.set(value, (g.values.get(value) ?? 0) + 1);
        if (!seenKeys.has(key)) {
          g.places++;
          seenKeys.add(key);
        }
      }
    }

    const order = [...groups.entries()].sort((a, b) => b[1].places - a[1].places);
    listEl.replaceChildren(...order.map(([key, g]) => renderGroup(key, g)));

    let text = visible.length === 0
      ? 'No categorized places in view.'
      : `${visible.length.toLocaleString()} places in ${groups.size} categories in view.`;
    if (data.truncated) text += ' This area is very dense, so only part of the data was loaded. Zoom in for complete counts.';
    setStatus(text, data.truncated ? 'warning' : '');
    renderHighlights();
  }

  function renderChip(key, value, count) {
    const id = `${key}=${value}`;
    const chip = el(
      'button',
      { type: 'button', class: 'chip', 'aria-pressed': String(selected.has(id)), title: `${key}=${value}` },
      el('span', { text: humanize(value) }),
      el('span', { class: 'count', text: count.toLocaleString() }),
    );
    chip.addEventListener('click', () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      chip.setAttribute('aria-pressed', String(selected.has(id)));
      renderHighlights();
    });
    return el('li', {}, chip);
  }

  function renderGroup(key, group) {
    const info = keyInfo(key);
    const values = [...group.values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const section = el(
      'section',
      { class: 'category' },
      el(
        'h3',
        {},
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { text: info.label }),
        el('code', { class: 'key', text: `${key}=*` }),
        el('span', { class: 'count', text: group.places.toLocaleString() }),
      ),
      el('ul', { class: 'chips' }, ...values.slice(0, VISIBLE_CHIPS).map(([v, n]) => renderChip(key, v, n))),
    );
    if (values.length > VISIBLE_CHIPS) {
      section.append(
        el(
          'details',
          {},
          el('summary', { text: `Show ${values.length - VISIBLE_CHIPS} more` }),
          el('ul', { class: 'chips' }, ...values.slice(VISIBLE_CHIPS).map(([v, n]) => renderChip(key, v, n))),
        ),
      );
    }
    // CSSOM property (not an inline style attribute), so it is allowed by our CSP.
    section.style.setProperty('--cat-color', info.color);
    return section;
  }

  function popupContent(f) {
    const box = el('div', { class: 'osm-popup' });
    box.append(el('strong', { text: f.name || humanize(f.c[0][1]) }));
    box.append(el('ul', {}, ...f.c.map(([k, v]) => el('li', { text: `${keyInfo(k).label}: ${humanize(v)}` }))));
    const type = OSM_TYPES[f.t];
    if (type && Number.isSafeInteger(f.id)) {
      box.append(
        el('a', {
          href: `https://www.openstreetmap.org/${type}/${f.id}`,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'View on OpenStreetMap',
        }),
      );
    }
    return box;
  }

  function renderHighlights() {
    highlightLayer.clearLayers();
    clearBtn.hidden = selected.size === 0;
    if (!data || selected.size === 0) return;

    let count = 0;
    for (const f of data.features) {
      const match = f.c.find(([k, v]) => selected.has(`${k}=${v}`));
      if (!match) continue;
      if (++count > MAX_MARKERS) break;
      L.circleMarker([f.lat, f.lon], {
        radius: 7,
        weight: 2,
        color: '#ffffff',
        fillColor: keyInfo(match[0]).color,
        fillOpacity: 0.9,
      })
        .bindPopup(() => popupContent(f)) // DOM node, not an HTML string
        .bindTooltip(f.name || humanize(match[1]), { direction: 'top', offset: [0, -6] })
        .addTo(highlightLayer);
    }
  }

  clearBtn.addEventListener('click', () => {
    selected.clear();
    for (const chip of listEl.querySelectorAll('.chip[aria-pressed="true"]')) chip.setAttribute('aria-pressed', 'false');
    renderHighlights();
  });

  refresh();
})();
