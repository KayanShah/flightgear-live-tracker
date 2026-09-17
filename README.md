# FlightGear Live Tracker

A local web app that shows your FlightGear aircraft moving on a real map in real time — built for VFR/IFR situational awareness, taxi guidance, and route planning.

> **Unofficial personal project.** Not affiliated with, endorsed by, or sponsored by the FlightGear project, VATSIM, or OurAirports. All trademarks belong to their respective owners.

## What is this?

It's a small Node server that polls FlightGear's built-in property server and serves a single-page Leaflet map showing your aircraft moving live, plus a set of tools for airport markup, taxi guidance, and route planning. No build step, no framework, no external services required to run (a couple of optional integrations aside).

## Features

### Live tracking

- **Live position** on an OpenStreetMap-based map, with heading, altitude, groundspeed, vertical speed, wind/crosswind, COM frequency and squawk read straight from FlightGear.
- **Flight trail**, **heading line**, and **autofollow** to keep the plane centered as it moves.

