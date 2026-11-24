// Downloads Camptocamp's ski touring routes around Verbier and saves them as
// data/routes.json (the dots on the map) and data/lines.json (the route lines).
// GitHub runs this once a week (see .github/workflows/routes.yml), because
// Camptocamp only lets its own website load routes inside a visitor's browser.
//
// Routes are © their Camptocamp authors, CC BY-SA 3.0. The map credits them and
// links each route back to Camptocamp.
//
// Run by hand with: node fetch-routes.mjs

import fs from 'node:fs/promises';
import path from 'node:path';

const API = (process.env.C2C_API || 'https://api.camptocamp.org').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 1000); // be gentle with a volunteer-run server
const PAGE = 100;
const MAX_ROUTES = 2000;
const REPO = process.env.GITHUB_REPOSITORY || 'trente';

// Verbier, the 4 Vallées and Val de Bagnes, in Web Mercator metres (west, south, east, north).
const BBOX = [790000, 5760000, 830000, 5800000];

const MERC_R = 6378137;
const RAD = Math.PI / 180;
const toLngLat = (x, y) => [
  Number(((x / MERC_R) / RAD).toFixed(5)),
  Number(((2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) / RAD).toFixed(5))
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': `Trente route map (github.com/${REPO})` }
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= 3) throw new Error(`${url}: ${error.message}`);
      await sleep(5000 * attempt);
    }
  }
}

const parseGeom = (text) => {
  try { return typeof text === 'string' ? JSON.parse(text) : null; } catch { return null; }
};
const isPlace = (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
const short = (v, n = 12) => (v === undefined || v === null ? '' : String(v).slice(0, n));

function title(doc) {
  const locales = Array.isArray(doc.locales) ? doc.locales : [];
  const pick = ['en', 'fr', 'de', 'it', 'es'].map((l) => locales.find((x) => x && x.lang === l)).find(Boolean) || locales[0];
  if (!pick) return 'Untitled route';
  const t = String(pick.title || '').trim();
  const p = String(pick.title_prefix || '').trim();
  return (p && t ? `${p}: ${t}` : p || t || 'Untitled route').slice(0, 140);
}

function distance(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Keep a point every 20 m or so, and at most about 250 points per route.
function thin(line) {
  let length = 0;
  for (let i = 1; i < line.length; i++) length += distance(line[i - 1], line[i]);
  const step = Math.max(20, length / 250);
  const kept = [line[0]];
  let since = 0;
  for (let i = 1; i < line.length; i++) {
    since += distance(line[i - 1], line[i]);
    if (since >= step || i === line.length - 1) {
      kept.push(line[i]);
      since = 0;
    }
  }
  return kept;
}

function lineOf(doc) {
  const detail = parseGeom(doc && doc.geometry && doc.geometry.geom_detail);
  let parts = [];
  if (detail && detail.type === 'LineString') parts = [detail.coordinates];
  else if (detail && detail.type === 'MultiLineString') parts = detail.coordinates;
  const line = [].concat(...(Array.isArray(parts) ? parts : [])).filter(isPlace).map((c) => toLngLat(c[0], c[1]));
  return line.length >= 2 ? thin(line) : null;
}

async function readOld(name) {
  try { return JSON.parse(await fs.readFile(path.join(OUT, name), 'utf8')); } catch { return null; }
}

async function main() {
  const oldRoutes = await readOld('routes.json');
  const oldLines = (await readOld('lines.json')) || {};
  const oldVersion = new Map((oldRoutes && oldRoutes.routes || []).map((r) => [r.id, r.v]));

  // 1. The list of routes, a page at a time.
  const docs = [];
  for (let offset = 0; offset < MAX_ROUTES; offset += PAGE) {
    const url = `${API}/routes?act=skitouring&bbox=${BBOX.join(',')}&limit=${PAGE}&offset=${offset}`;
    const page = await getJson(url);
    const batch = page && Array.isArray(page.documents) ? page.documents : [];
    docs.push(...batch);
    const total = page && Number.isFinite(page.total) ? page.total : docs.length;
    console.log(`Listed ${docs.length} of ${total} routes`);
    if (batch.length < PAGE || docs.length >= total) break;
    await sleep(PAUSE_MS);
  }
  if (!docs.length) throw new Error('Camptocamp returned no routes, so the old files are kept.');

  // 2. Each route's line, reusing last week's copy when the route hasn't changed.
  const routes = [];
  const lines = {};
  let fetched = 0;
  for (const doc of docs) {
    const id = Number(doc.document_id);
    const point = parseGeom(doc.geometry && doc.geometry.geom);
    if (!Number.isInteger(id) || !point || point.type !== 'Point' || !isPlace(point.coordinates)) continue;
    const version = Number(doc.version) || 0;
    let line = null;
    if (doc.geometry.has_geom_detail === true) {
      if (oldVersion.get(id) === version && oldLines[id]) {
        line = oldLines[id];
      } else {
        await sleep(PAUSE_MS);
        line = lineOf(await getJson(`${API}/routes/${id}`));
        fetched++;
      }
    }
    if (line) lines[id] = line;
    const [lng, lat] = toLngLat(point.coordinates[0], point.coordinates[1]);
    routes.push({
      id,
      v: version,
      title: title(doc),
      ski: short(doc.ski_rating),
      exposure: short(doc.ski_exposition),
      overall: short(doc.labande_global_rating),
      up: Number.isFinite(doc.height_diff_up) ? doc.height_diff_up : null,
      max: Number.isFinite(doc.elevation_max) ? doc.elevation_max : null,
      line: Boolean(line),
      lng,
      lat
    });
  }

  await fs.mkdir(OUT, { recursive: true });
  const meta = {
    source: 'https://www.camptocamp.org',
    licence: 'CC BY-SA 3.0, https://creativecommons.org/licenses/by-sa/3.0/',
    note: "Routes by Camptocamp contributors. Each route's authors: https://www.camptocamp.org/routes/history/{id}",
    updated: new Date().toISOString().slice(0, 10)
  };
  await fs.writeFile(path.join(OUT, 'routes.json'), JSON.stringify({ ...meta, routes }));
  await fs.writeFile(path.join(OUT, 'lines.json'), JSON.stringify(lines));
  console.log(`Saved ${routes.length} routes, ${Object.keys(lines).length} with lines (${fetched} lines downloaded this time).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
