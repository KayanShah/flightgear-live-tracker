# FlightGear Live Tracker

A local web app that shows your FlightGear aircraft moving on a real map in real time — built for VFR/IFR situational awareness, taxi guidance, and route planning.

> **Unofficial personal project.** Not affiliated with, endorsed by, or sponsored by the FlightGear project, VATSIM, or OurAirports. All trademarks belong to their respective owners.

## What is this?

It's a small Node server that polls FlightGear's built-in property server and serves a single-page Leaflet map showing your aircraft moving live, plus a set of tools for airport markup, taxi guidance, and route planning. No build step, no framework, no external services required to run (a couple of optional integrations aside).

## Features

### Live tracking

- **Live position** on an OpenStreetMap-based map, with heading, altitude, groundspeed, vertical speed, wind/crosswind, COM frequency and squawk read straight from FlightGear.
- **Flight trail**, **heading line**, and **autofollow** to keep the plane centered as it moves.

### Airport markup

- **Taxiway and holding-point labels** for several major airports (pulled from OpenStreetMap), each draggable/editable in place to correct for local inaccuracies.
- **Drawing tools**: point labels, lines, freehand strokes, and a 90° arc tool for turn-radius planning — all with undo and persistent storage.
- Every save is atomic and automatically backed up before every write, so accidental edits are always recoverable.

### Taxi Route

Type an ATC taxi clearance in plain English and it draws the route along real taxiway pavement (via a routing graph built from OpenStreetMap geometry), parsed by a local LLM (Ollama) with a deterministic phonetic-alphabet fallback if Ollama isn't running. A grounding check rejects any identifier the model invents that wasn't actually in the clearance.

### Route Import

Paste a SimBrief-style OFP navlog and it plots every waypoint plus a connecting line, with generated UNICOM self-announce calls for the departure and arrival. Parsed with a regex extractor, not an LLM, since coordinates need to be exact.

### Reference tools

- **Circuit leg heading calculator** (upwind/crosswind/downwind/base/final).
- **UK aerodrome search** (plus a few hand-added international fields) with fly-to-result and pin-dropping.
- **Airport radio frequencies**, looked up from the nearest aerodrome.
- **Live VATSIM ATC frequency advisory** — which controller you should actually be on right now, if any are online, matched to your current flight phase.

### Flight history

Continuous server-side position logging, independent of the browser tab, for post-flight turn/maneuver analysis.

## Prerequisites

- **Node.js 20+** (uses built-in `fetch`, no npm dependencies at all).
- **FlightGear**, launched with the property server enabled — add this to the launcher's "Additional Settings" box:
  ```
  --httpd=8080
  ```
- *(Optional)* **[Ollama](https://ollama.com)** running locally with the `llama3` model pulled, for AI-assisted taxi-instruction parsing. Without it, Taxi Route still works via a scripted phonetic-alphabet fallback.

## Setup

1. **Clone this repo** and `cd` into it.

2. **Download the two datasets** this app uses for airport search and frequencies (public domain, from the [OurAirports](https://ourairports.com/data/) project — not included in this repo since they're large and change over time):
   ```bash
   curl -L -o airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
   curl -L -o airport-frequencies.csv https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv
   ```

