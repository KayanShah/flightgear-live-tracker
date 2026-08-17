# FlightGear Live Tracker

A local web app that shows your FlightGear aircraft moving on a real map in
real time — built for VFR/IFR situational awareness, taxi guidance, and
route planning. It's a small Node server that polls FlightGear's built-in
property server and a single-page Leaflet map, with no build step and no
external services required to run (a couple of optional integrations
aside).

Unofficial personal project — not affiliated with FlightGear, VATSIM, or
OurAirports.

## Features

- **Live position** on an OpenStreetMap-based map, with heading, altitude,
  groundspeed, vertical speed, wind/crosswind, COM frequency and squawk
  read straight from FlightGear.
- **Taxiway and holding-point labels** for several major airports (pulled
  from OpenStreetMap), each draggable/editable in place to correct for
  local inaccuracies.
- **Drawing tools**: point labels, lines, freehand strokes, and a 90° arc
  tool for turn-radius planning — all with undo and persistent storage.
- **Taxi Route**: type an ATC taxi clearance in plain English and it draws
  the route along real taxiway pavement (via a local routing graph),
  parsed by a local LLM (Ollama) with a deterministic phonetic-alphabet
  fallback if Ollama isn't running.
- **Route Import**: paste a SimBrief-style OFP navlog and it plots every
  waypoint plus a connecting line — parsed with a regex extractor, not an
  LLM, since coordinates need to be exact.
- **Circuit leg headings**, a **UK aerodrome search** (plus a few
  hand-added international fields), **airport radio frequencies**, and a
  **live VATSIM ATC frequency advisory** (which controller you should
  actually be on right now, if any are online).
- **Flight history logging** to disk (independent of the browser tab)
  for post-flight turn/maneuver analysis.

## Prerequisites

- **Node.js 20+** (uses built-in `fetch`, no npm dependencies at all).
- **FlightGear**, launched with the property server enabled — add this to
  the launcher's "Additional Settings" box:
  ```
  --httpd=8080
  ```
- *(Optional)* **[Ollama](https://ollama.com)** running locally with the
  `llama3` model pulled, for AI-assisted taxi-instruction parsing. Without
  it, Taxi Route still works via a scripted phonetic-alphabet fallback.

## Setup

1. **Clone this repo** and `cd` into it.

2. **Download the two datasets** this app uses for airport search and
   frequencies (public domain, from the [OurAirports](https://ourairports.com/data/)
   project — not included in this repo since they're large and change
   over time):
   ```bash
   curl -L -o airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
   curl -L -o airport-frequencies.csv https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv
   ```

3. **Launch FlightGear** with `--httpd=8080` as above, and load into a flight.

4. **Start the server**:
   ```bash
   npm start
   # or: node server.js
   ```

5. Open **http://localhost:3000**.

## Configuration

All optional, set as environment variables before starting the server:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port this app's own server listens on |
| `FG_HOST` | `localhost` | Host FlightGear's httpd is running on |
| `FG_PORT` | `8080` | Port FlightGear's httpd is running on |
| `FG_ROOT` | `/Applications/fgdata_2024_1` | Path to your FlightGear data directory, used to read `Navaids/fix.dat.gz` for the enroute waypoint overlay |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server address |
| `OLLAMA_MODEL` | `llama3` | Model used for Taxi Route parsing |

## Data & attribution

- Taxiway/holding-point data in `taxiway-graphs/` and the map tiles
  themselves are © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, available under the [ODbL](https://opendatacommons.org/licenses/odbl/).
- Airport and frequency data from [OurAirports](https://ourairports.com/),
  public domain.
- Live ATC data from the [VATSIM](https://vatsim.net) public data feed.
- Nav fix data from FlightGear's own bundled `Navaids/fix.dat`.

## Notes

- `markings.json` (your labels/lines/arcs) and `flight-logs/` are created
  automatically on first run and are gitignored — they're your own data,
  not shared by this repo.
- Every save to `markings.json` is atomic and automatically backed up to
  `markings-backups/` beforehand, so accidental edits/deletions are always
  recoverable.
