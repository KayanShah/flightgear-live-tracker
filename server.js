// Relay server: polls FlightGear's built-in httpd (property tree JSON)
// and re-serves clean position data + the static map page, all from one
// origin, so the browser never has to make a cross-origin request to FG.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const FG_HOST = process.env.FG_HOST || 'localhost';
const FG_PORT = process.env.FG_PORT || 8080;
const MARKINGS_FILE = path.join(__dirname, 'markings.json');
const MARKINGS_BACKUP_DIR = path.join(__dirname, 'markings-backups');
const MAX_BACKUPS = 100;
const FG_ROOT = process.env.FG_ROOT || '/Applications/fgdata_2024_1';
const FIX_DAT_PATH = path.join(FG_ROOT, 'Navaids', 'fix.dat.gz');
const TAXIWAY_GRAPHS_DIR = path.join(__dirname, 'taxiway-graphs');

// --- Taxiway centerline graphs (real OSM pavement geometry) for routing.
// Loaded once per airport code from taxiway-graphs/<ICAO>.json, each built
// from OSM way node membership so shared nodes at intersections connect
// the graph properly, instead of just interpolating between labels.
const TAXIWAY_GRAPHS = new Map(); // icao -> { nodes: Map(id -> [lat,lon]), adj: Map(id -> [{to,dist}]) }

function loadTaxiwayGraph(icao) {
  if (TAXIWAY_GRAPHS.has(icao)) return TAXIWAY_GRAPHS.get(icao);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(TAXIWAY_GRAPHS_DIR, `${icao}.json`), 'utf8'));
    const nodes = new Map(Object.entries(raw.nodes));
    const adj = new Map();
    for (const [a, b, dist] of raw.edges) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push({ to: b, dist });
      adj.get(b).push({ to: a, dist });
    }
    const graph = { nodes, adj };
    TAXIWAY_GRAPHS.set(icao, graph);
    return graph;
  } catch {
    TAXIWAY_GRAPHS.set(icao, null);
    return null;
  }
}

// Which cached airport graph is closest to this position, so a route near
// EGWU doesn't accidentally try to route through EGCC's graph, etc.
const GRAPH_AIRPORTS = [
  { icao: 'EGCC', lat: 53.3537, lon: -2.275 },
];

function nearestAirportGraph(lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const a of GRAPH_AIRPORTS) {
    const d = haversineNm(lat, lon, a.lat, a.lon);
    if (d < bestDist) {
      bestDist = d;
      best = a.icao;
    }
  }
  if (bestDist > 5) return null; // too far from any known airport's graph
  return loadTaxiwayGraph(best);
}

function nearestGraphNode(graph, lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const [id, [nlat, nlon]] of graph.nodes) {
    const d = (nlat - lat) ** 2 + (nlon - lon) ** 2; // planar approx is fine at this scale
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

// Plain O(V^2) Dijkstra — graphs here are only ~100-1600 nodes, no need
// for a binary heap.
function dijkstra(graph, startId, endId) {
  const dist = new Map([[startId, 0]]);
  const prev = new Map();
  const visited = new Set();
  for (;;) {
    let u = null;
    let uDist = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < uDist) {
        uDist = d;
        u = id;
      }
    }
    if (u === null) break;
    if (u === endId) break;
    visited.add(u);
    for (const { to, dist: edgeDist } of graph.adj.get(u) || []) {
      const alt = uDist + edgeDist;
      if (alt < (dist.get(to) ?? Infinity)) {
        dist.set(to, alt);
        prev.set(to, u);
      }
    }
  }
  if (!dist.has(endId)) return null;
  const path = [endId];
  let cur = endId;
  while (cur !== startId) {
    cur = prev.get(cur);
    if (cur === undefined) return null;
    path.push(cur);
  }
  path.reverse();
  return path.map((id) => graph.nodes.get(id));
}

// Route a sequence of [lat,lon] waypoints along real taxiway pavement,
// falling back to a straight hop between any pair that can't be routed
// (no graph for that airport, or the graph is disconnected there).
function routeAlongTaxiways(waypoints, lat, lon) {
  const graph = nearestAirportGraph(lat, lon);
  if (!graph || waypoints.length < 2) return waypoints;

  const routed = [waypoints[0]];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const fromNode = nearestGraphNode(graph, waypoints[i][0], waypoints[i][1]);
    const toNode = nearestGraphNode(graph, waypoints[i + 1][0], waypoints[i + 1][1]);
    const path = fromNode && toNode ? dijkstra(graph, fromNode, toNode) : null;
    if (path && path.length > 0) {
      routed.push(...path, waypoints[i + 1]);
    } else {
      routed.push(waypoints[i + 1]);
    }
  }
  return routed;
}

const AIRPORTS_CSV_PATH = path.join(__dirname, 'airports.csv');

// Minimal RFC4180 CSV line splitter — handles quoted fields containing
// commas (airport names sometimes have them) without pulling in a dependency.
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

// Non-UK airfields explicitly added to the search despite the GB filter.
const EXTRA_AIRPORT_IDENTS = new Set(['LFMF', 'VNLK']);

// UK aerodrome search data, from the public-domain OurAirports dataset
// (ourairports.com/data/airports.csv), filtered down to GB entries plus
// any explicit exceptions above.
function loadAirports() {
  try {
    const text = fs.readFileSync(AIRPORTS_CSV_PATH, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const header = parseCsvLine(lines[0]);
    const col = (name) => header.indexOf(name);
    const idxs = {
      ident: col('ident'),
      type: col('type'),
      name: col('name'),
      lat: col('latitude_deg'),
      lon: col('longitude_deg'),
      country: col('iso_country'),
      municipality: col('municipality'),
      icao: col('icao_code'),
      iata: col('iata_code'),
      elevation: col('elevation_ft'),
    };
    const airports = [];
    for (let i = 1; i < lines.length; i++) {
      const f = parseCsvLine(lines[i]);
      if (f[idxs.country] !== 'GB' && !EXTRA_AIRPORT_IDENTS.has(f[idxs.ident])) continue;
      if (f[idxs.type] === 'closed') continue;
      const lat = parseFloat(f[idxs.lat]);
      const lon = parseFloat(f[idxs.lon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      airports.push({
        ident: f[idxs.ident] || '',
        icao: f[idxs.icao] || '',
        iata: f[idxs.iata] || '',
        name: f[idxs.name] || '',
        municipality: f[idxs.municipality] || '',
        type: f[idxs.type] || '',
        lat,
        lon,
        elevationFt: parseFloat(f[idxs.elevation]) || 0,
      });
    }
    console.log(`Loaded ${airports.length} UK aerodromes from ${AIRPORTS_CSV_PATH}`);
    return airports;
  } catch (err) {
    console.warn(`Could not load airports from ${AIRPORTS_CSV_PATH}: ${err.message}`);
    return [];
  }
}

const AIRPORTS = loadAirports();

const AIRPORT_FREQUENCIES_CSV_PATH = path.join(__dirname, 'airport-frequencies.csv');

// Frequencies keyed by airport_ident, from the companion OurAirports
// dataset (ourairports.com/data/airport-frequencies.csv) — only kept for
// airports we actually have in AIRPORTS, so this stays small in memory.
function loadAirportFrequencies() {
  try {
    const text = fs.readFileSync(AIRPORT_FREQUENCIES_CSV_PATH, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const header = parseCsvLine(lines[0]);
    const col = (name) => header.indexOf(name);
    const idxs = { ident: col('airport_ident'), type: col('type'), desc: col('description'), mhz: col('frequency_mhz') };
    const knownIdents = new Set(AIRPORTS.map((a) => a.ident));
    const byIdent = new Map();
    for (let i = 1; i < lines.length; i++) {
      const f = parseCsvLine(lines[i]);
      const ident = f[idxs.ident];
      if (!knownIdents.has(ident)) continue;
      const mhz = parseFloat(f[idxs.mhz]);
      if (!Number.isFinite(mhz)) continue;
      if (!byIdent.has(ident)) byIdent.set(ident, []);
      byIdent.get(ident).push({ type: f[idxs.type] || '', description: f[idxs.desc] || '', mhz });
    }
    applyFrequencyOverrides(byIdent);
    console.log(`Loaded frequencies for ${byIdent.size} airports from ${AIRPORT_FREQUENCIES_CSV_PATH}`);
    return byIdent;
  } catch (err) {
    console.warn(`Could not load airport frequencies: ${err.message}`);
    return new Map();
  }
}

// The free OurAirports dataset is community-maintained and sometimes wrong
// — e.g. rounding an 8.33kHz-spaced real-world frequency (118.705) down to
// the older 25kHz value (118.700). This file lets specific entries be
// corrected by hand without trying to fix the whole dataset.
const AIRPORT_FREQUENCY_OVERRIDES_PATH = path.join(__dirname, 'airport-frequency-overrides.json');

function applyFrequencyOverrides(byIdent) {
  let overrides;
  try {
    overrides = JSON.parse(fs.readFileSync(AIRPORT_FREQUENCY_OVERRIDES_PATH, 'utf8'));
  } catch {
    return;
  }
  for (const [ident, entries] of Object.entries(overrides)) {
    const existing = byIdent.get(ident) || [];
    for (const override of entries) {
      const i = existing.findIndex((e) => e.type === override.type);
      if (i >= 0) existing[i] = override;
      else existing.push(override);
    }
    byIdent.set(ident, existing);
  }
}

const AIRPORT_FREQUENCIES = loadAirportFrequencies();

function findNearestAirport(lat, lon, maxNm = 8) {
  let best = null;
  let bestDist = Infinity;
  for (const a of AIRPORTS) {
    const d = haversineNm(lat, lon, a.lat, a.lon);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  if (!best || bestDist > maxNm) return null;
  return best;
}

const PROPS = {
  lat: 'position/latitude-deg',
  lon: 'position/longitude-deg',
  altFt: 'position/altitude-ft',
  heading: 'orientation/heading-deg',
  groundspeedKt: 'velocities/groundspeed-kt',
  callsign: 'sim/multiplay/callsign',
};

async function fetchProp(propPath) {
  const url = `http://${FG_HOST}:${FG_PORT}/json/${propPath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`FlightGear httpd returned ${res.status} for ${propPath}`);
  const data = await res.json();
  return data.value;
}

async function fetchPosition() {
  const result = {};
  for (const [key, propPath] of Object.entries(PROPS)) {
    result[key] = await fetchProp(propPath);
  }
  return result;
}
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

function readMarkings() {
  try {
    const data = JSON.parse(fs.readFileSync(MARKINGS_FILE, 'utf8'));
    if (!Array.isArray(data.arcs)) data.arcs = []; // older files predate arcs
    return data;
  } catch {
    return { labels: [], lines: [], arcs: [] };
  }
}

// Snapshot the current on-disk file before every overwrite, so hours of
// manual label placement can never be lost to a bad save, a client bug,
// or an accidental Clear All — only deleting these files by hand can.
function backupMarkings() {
  if (!fs.existsSync(MARKINGS_FILE)) return;
  fs.mkdirSync(MARKINGS_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(MARKINGS_FILE, path.join(MARKINGS_BACKUP_DIR, `markings-${stamp}.json`));

  const files = fs.readdirSync(MARKINGS_BACKUP_DIR).filter((f) => f.endsWith('.json')).sort();
  const excess = files.length - MAX_BACKUPS;
  if (excess > 0) {
    for (const f of files.slice(0, excess)) {
      fs.unlinkSync(path.join(MARKINGS_BACKUP_DIR, f));
    }
  }
}

function writeMarkingsAtomic(data) {
  backupMarkings();
  const tmpFile = `${MARKINGS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, MARKINGS_FILE); // atomic on the same filesystem
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/position') {
    try {
      const pos = await fetchPosition();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...pos, ts: Date.now() }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url.startsWith('/api/airports') && req.method === 'GET') {
    const q = new URL(req.url, `http://${req.headers.host}`).searchParams.get('q') || '';
    const needle = q.trim().toUpperCase();
    let results = [];
    if (needle.length >= 2) {
      results = AIRPORTS.filter(
        (a) =>
          a.ident.toUpperCase().includes(needle) ||
          a.icao.toUpperCase().includes(needle) ||
          a.iata.toUpperCase().includes(needle) ||
          a.name.toUpperCase().includes(needle) ||
          a.municipality.toUpperCase().includes(needle)
      ).slice(0, 25);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  if (req.url.startsWith('/api/nearest-airport-frequencies') && req.method === 'GET') {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const lat = Number(params.get('lat'));
    const lon = Number(params.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected ?lat=&lon=' }));
      return;
    }
    const airport = findNearestAirport(lat, lon);
    const result = airport
      ? { airport, frequencies: AIRPORT_FREQUENCIES.get(airport.ident) || [] }
      : { airport: null, frequencies: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url === '/api/markings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readMarkings()));
    return;
  }

  if (req.url === '/api/markings' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed.labels) || !Array.isArray(parsed.lines) || !Array.isArray(parsed.arcs)) {
        throw new Error('Expected { labels: [], lines: [], arcs: [] }');
      }
      writeMarkingsAtomic(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Tracker running at http://localhost:${PORT}`);
  console.log(`Polling FlightGear httpd at http://${FG_HOST}:${FG_PORT}`);
  startFlightLogging();
});
