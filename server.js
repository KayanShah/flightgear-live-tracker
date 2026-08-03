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

const PROPS = {
  lat: 'position/latitude-deg',
  lon: 'position/longitude-deg',
  altFt: 'position/altitude-ft',
  heading: 'orientation/heading-deg',
  groundspeedKt: 'velocities/groundspeed-kt',
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
