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

// Only keep fixes within this radius of EGCC so the payload stays small
// and relevant, rather than shipping FlightGear's whole worldwide dataset.
const EGCC = { lat: 53.3537, lon: -2.2750 };
const WAYPOINT_RADIUS_NM = 80;

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function loadWaypoints() {
  try {
    const gz = fs.readFileSync(FIX_DAT_PATH);
    const text = zlib.gunzipSync(gz).toString('utf8');
    const fixes = [];
    for (const line of text.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 3) continue;
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      const name = parts[2];
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !/^[A-Z0-9]{2,5}$/.test(name)) continue;
      if (haversineNm(lat, lon, EGCC.lat, EGCC.lon) <= WAYPOINT_RADIUS_NM) {
        fixes.push({ lat, lon, name });
      }
    }
    console.log(`Loaded ${fixes.length} nav fixes within ${WAYPOINT_RADIUS_NM}nm of EGCC from ${FIX_DAT_PATH}`);
    return fixes;
  } catch (err) {
    console.warn(`Could not load nav fixes from ${FIX_DAT_PATH}: ${err.message}`);
    return [];
  }
}

const WAYPOINTS = loadWaypoints();

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
  { icao: 'EGTR', lat: 51.6553, lon: -0.3305 },
  { icao: 'EGWU', lat: 51.553, lon: -0.418 },
  { icao: 'EGBO', lat: 52.5163, lon: -2.2617 },
  { icao: 'EGNX', lat: 52.8289, lon: -1.3326 },
  { icao: 'EGPH', lat: 55.9494, lon: -3.3615 },
  { icao: 'EGBK', lat: 52.3055, lon: -0.7903 },
  { icao: 'EGLL', lat: 51.4701, lon: -0.4582 },
  { icao: 'EGSS', lat: 51.8882, lon: 0.2456 },
  { icao: 'VABB', lat: 19.0911, lon: 72.8675 },
  { icao: 'KDFW', lat: 32.8967, lon: -97.0348 },
  { icao: 'KLAX', lat: 33.9401, lon: -118.4082 },
  { icao: 'EGKK', lat: 51.1527, lon: -0.1803 },
  { icao: 'WSSS', lat: 1.3519, lon: 103.9939 },
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
const EXTRA_AIRPORT_IDENTS = new Set(['LFMF', 'VNLK', 'WSSS', 'KDFW', 'KLAX']);

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

// --- Taxi instruction parsing: turn ATC phrasing into an ordered list of
// real taxiway/holding-point identifiers already placed on the map -------
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const TAXI_INSTRUCTION_RADIUS_NM = 3; // scope to "whichever airport you're at"

const PHONETIC = {
  alpha: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F',
  golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J', kilo: 'K',
  lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q',
  romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U', victor: 'V',
  whiskey: 'W', xray: 'X', 'x-ray': 'X', yankee: 'Y', zulu: 'Z',
};
const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', niner: '9',
};

function findNearbyLabels(markings, lat, lon, radiusNm) {
  return markings.labels.filter((l) => haversineNm(l.lat, l.lon, lat, lon) <= radiusNm);
}

const LETTER_TO_PHONETIC = {};
for (const [word, letter] of Object.entries(PHONETIC)) {
  (LETTER_TO_PHONETIC[letter] ??= []).push(word);
}
const DIGIT_TO_WORD = {};
for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
  (DIGIT_TO_WORD[digit] ??= []).push(word);
}

// Grounding check: an LLM can get the ordering right but still hallucinate
// an identifier that was never actually said. Before trusting anything it
// returns, verify each identifier (or its phonetic spelling) is genuinely
// present in the original clearance text — reject it otherwise.
function isIdentifierGrounded(id, lowerText) {
  if (new RegExp(`\\b${id.toLowerCase()}\\b`).test(lowerText)) return true;
  const letters = id.match(/^[A-Za-z]+/)?.[0] || '';
  const digits = id.match(/\d+$/)?.[0] || '';
  for (const ch of letters) {
    const words = LETTER_TO_PHONETIC[ch.toUpperCase()] || [];
    if (!new RegExp(`\\b(${ch.toLowerCase()}|${words.join('|')})\\b`).test(lowerText)) return false;
  }
  if (digits) {
    const words = digits.split('').flatMap((d) => DIGIT_TO_WORD[d] || []);
    if (!new RegExp(`\\b(${digits}|${words.join('|')})\\b`).test(lowerText)) return false;
  }
  return true;
}

// Deterministic fallback (no LLM needed): normalize phonetic words/number
// words to letters/digits, then scan for runs that match a known identifier.
// Normalizes one phrase ("Echo", "Juliet One", "J1", "delta") down to a
// bare identifier code ("E", "J1", "J1", "D"). Used both for the scripted
// parser and to clean up the LLM's output, since it reliably gets the
// *order* right but doesn't always convert phonetic words to codes itself
// despite being asked to.
function phraseToIdentifierCode(phrase) {
  const words = phrase
    .replace(/[.,;]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      if (PHONETIC[lower]) return PHONETIC[lower];
      if (NUMBER_WORDS[lower]) return NUMBER_WORDS[lower];
      if (/^\d+$/.test(w)) return w;
      if (/^[A-Za-z]{1,2}\d*$/.test(w)) return w.toUpperCase();
      return null;
    })
    .filter(Boolean);
  return words.join('');
}

function parseTaxiInstructionScripted(text, candidates) {
  const upperToOriginal = new Map(candidates.map((c) => [c.toUpperCase(), c]));
  const words = text
    .replace(/[.,;]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      if (PHONETIC[lower]) return PHONETIC[lower];
      if (NUMBER_WORDS[lower]) return NUMBER_WORDS[lower];
      if (/^\d+$/.test(w)) return w;
      if (/^[A-Za-z]{1,2}\d*$/.test(w)) return w.toUpperCase();
      return null;
    });

  const sequence = [];
  for (let i = 0; i < words.length; i++) {
    if (!words[i]) continue;
    // Letter directly followed by a number token ("Delta" "9" -> "D9")
    if (/^[A-Z]{1,2}$/.test(words[i]) && words[i + 1] && /^\d+$/.test(words[i + 1])) {
      const combo = words[i] + words[i + 1];
      if (upperToOriginal.has(combo)) {
        const orig = upperToOriginal.get(combo);
        if (!sequence.includes(orig)) sequence.push(orig);
        i++;
        continue;
      }
    }
    if (upperToOriginal.has(words[i])) {
      const orig = upperToOriginal.get(words[i]);
      if (!sequence.includes(orig)) sequence.push(orig);
    }
  }
  return sequence;
}

async function parseTaxiInstructionLLM(text, candidates) {
  const prompt =
    `You convert an ATC ground taxi clearance into an ordered JSON array of taxiway/holding-point identifiers.\n` +
    `Valid identifiers at this airport (use ONLY these, exact casing): ${candidates.join(', ')}\n` +
    `Phonetic alphabet words (Alpha, Bravo, ...) mean their letter ALONE ("Juliet" by itself means "J", ` +
    `NOT "J1" — only attach a number if a number word/digit immediately follows, e.g. "Juliet One" or ` +
    `"Juliet 1" means "J1"). Ignore runway/gate/stand mentions entirely, only list taxiway and holding ` +
    `point identifiers, in the order the aircraft would actually travel them (the "via" list, in order). ` +
    `A clearance limit stated at the start (e.g. "Taxi to holding point J1 via...") is the FINAL destination ` +
    `— it belongs at the END of the array, not the start, even though it's mentioned first in the sentence. ` +
    `If the same identifier is effectively mentioned twice (once as the stated clearance limit, once again ` +
    `at the end as "hold short ... at Juliet one"), only include it ONCE, at the end.\n` +
    `Clearance: "${text}"\n` +
    `Respond with ONLY a JSON array of strings, nothing else, e.g. ["B","D","J1"]`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0 } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const data = await res.json();
  const match = data.response.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Model did not return a JSON array');
  const parsed = JSON.parse(match[0]);
  const upperToOriginal = new Map(candidates.map((c) => [c.toUpperCase(), c]));
  const lowerText = text.toLowerCase();
  const sequence = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    // Try the raw item first (model may have already given "J1"), then
    // fall back to normalizing phonetic/number words ("Juliet One" -> "J1").
    const code = upperToOriginal.has(item.toUpperCase()) ? item.toUpperCase() : phraseToIdentifierCode(item);
    if (!upperToOriginal.has(code)) continue;
    // Reject anything the model invented that isn't actually traceable
    // back to the clearance text — better to under-draw than hallucinate
    // a waypoint that was never said.
    if (!isIdentifierGrounded(code, lowerText)) continue;
    sequence.push(upperToOriginal.get(code));
  }
  // If something's mentioned twice (stated clearance limit + repeated at
  // the end), keep only its LAST occurrence — that's the one that reflects
  // where it actually belongs in the route.
  const deduped = [];
  const seen = new Set();
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (!seen.has(sequence[i])) {
      seen.add(sequence[i]);
      deduped.unshift(sequence[i]);
    }
  }
  return deduped;
}

// --- SimBrief-style OFP navlog parser -----------------------------------
// Deterministic regex extraction, not LLM-based: this is exact structured
// coordinate data (DDMM.m / DDDMM.m format), and an LLM re-typing digits
// risks silently transposing a number — a real safety concern for a route
// someone's actually flying. A parser either matches the format or it
// doesn't; it can't "almost" get a coordinate right.
//
// Format (one block per waypoint, appears twice per fix in the navlog):
//   NAME_OR_IDENT   N/SDDMM.m  ...(other columns)...
//   IDENT2          E/WDDDMM.m ...(other columns)...
// IDENT2 is usually the same as the first ident, but sometimes a shorter
// code (e.g. "ISED044002" / "D044B"), and is blank for "T O C"/"T O D"
// entries. FIR boundary crossings are prefixed with "-" and are skipped —
// they're not real route waypoints.
function parseNavlog(text) {
  const latRe = /\b([NS])(\d{2})(\d{2}(?:\.\d+)?)\b/;
  const lonRe = /\b([EW])(\d{3})(\d{2}(?:\.\d+)?)\b/;

  const latMatches = [];
  const lonMatches = [];

  for (const line of text.split('\n')) {
    const latM = latRe.exec(line);
    if (latM) {
      const name = line.slice(0, latM.index).replace(/\s+/g, ' ').trim();
      let lat = parseInt(latM[2], 10) + parseFloat(latM[3]) / 60;
      if (latM[1] === 'S') lat = -lat;
      latMatches.push({ name, lat });
      continue; // a line has either a lat or a lon token, never both
    }
    const lonM = lonRe.exec(line);
    if (lonM) {
      const name = line.slice(0, lonM.index).replace(/\s+/g, ' ').trim();
      let lon = parseInt(lonM[2], 10) + parseFloat(lonM[3]) / 60;
      if (lonM[1] === 'W') lon = -lon;
      lonMatches.push({ name, lon });
    }
  }

  const count = Math.min(latMatches.length, lonMatches.length);
  const waypoints = [];
  const seen = new Map();
  for (let i = 0; i < count; i++) {
    const latEntry = latMatches[i];
    const lonEntry = lonMatches[i];
    const rawName = (lonEntry.name || latEntry.name).replace(/\s+/g, '');
    if (!rawName || rawName.startsWith('-')) continue; // FIR boundary crossing

    const n = (seen.get(rawName) || 0) + 1;
    seen.set(rawName, n);
    const id = n > 1 ? `${rawName}(${n})` : rawName;

    waypoints.push({
      id,
      lat: Math.round(latEntry.lat * 1e6) / 1e6,
      lon: Math.round(lonEntry.lon * 1e6) / 1e6,
    });
  }
  return { waypoints, latCount: latMatches.length, lonCount: lonMatches.length };
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

  if (req.url === '/api/waypoints' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(WAYPOINTS));
    return;
  }

  if (req.url === '/api/parse-navlog' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { text } = JSON.parse(body);
      if (typeof text !== 'string' || !text.trim()) throw new Error('Expected { text }');
      const result = parseNavlog(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/api/taxi-route' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { text, lat, lon } = JSON.parse(body);
      if (typeof text !== 'string' || !text.trim() || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('Expected { text, lat, lon }');
      }
      const markings = readMarkings();
      const nearby = findNearbyLabels(markings, lat, lon, TAXI_INSTRUCTION_RADIUS_NM);
      const candidateTexts = [...new Set(nearby.map((l) => l.text))];

      let sequenceTexts;
      let usedLLM = true;
      try {
        sequenceTexts = await parseTaxiInstructionLLM(text, candidateTexts);
        if (sequenceTexts.length === 0) throw new Error('empty result, falling back');
      } catch (err) {
        console.warn(`Ollama parse failed (${err.message}), falling back to scripted parser`);
        usedLLM = false;
        sequenceTexts = parseTaxiInstructionScripted(text, candidateTexts);
      }

      // Resolve each identifier to real coordinates, picking whichever
      // instance (of a repeated letter) is nearest the previous point.
      let cursor = { lat, lon };
      const points = [];
      const resolved = [];
      for (const t of sequenceTexts) {
        const options = nearby.filter((l) => l.text === t);
        if (options.length === 0) continue;
        const best = options.reduce((a, b) =>
          haversineNm(cursor.lat, cursor.lon, a.lat, a.lon) <= haversineNm(cursor.lat, cursor.lon, b.lat, b.lon) ? a : b
        );
        points.push([best.lat, best.lon]);
        resolved.push(t);
        cursor = best;
      }

      // Snap the waypoint-to-waypoint hops onto real taxiway pavement
      // instead of drawing straight lines across grass/buildings.
      const routedPoints = routeAlongTaxiways(points, lat, lon);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sequence: resolved, points: routedPoints, usedLLM }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
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
