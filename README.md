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

