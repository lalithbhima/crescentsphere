# Lunar Landing Site Navigator

**NASA Space Apps Challenge 2026** · Lunar landing site and date evaluation for power and direct-to-Earth communication

**Live site:** https://lunar-navigator-2026.web.app

An interactive 3D web app that lets mission planners, educators and the public compare lunar landing sites and dates in seconds.
Fly from Earth to the Moon at true scale, click any point on the Moon, drop to the surface, and see when the Sun and Earth are above the horizon.
That tells you whether a lander there would have power (Sun) and a direct line to Earth (communications).

## Team

| Member | Role |
|---|---|
| **Lalithendra Reddy Bhima** | Team member |
| **Bhavika Bhima** | Team member |

## The challenge

Missions to the Moon's south pole face extreme lighting and communication limits. NASA's CLPS (Commercial Lunar Payload Services) program flies
robotic **lunar landers** that need sunlight for their solar arrays and a view of Earth for direct communication. Existing tools (Quickmap, Moon Trek,
JPL Horizons) are powerful but hard to use for quick comparisons. This project turns that data into clear, comparable visuals.

## Features

| What the challenge asks for | What the app does |
|---|---|
| Pick a site | 59 curated sites (6 Apollo, 4 CLPS, 7 international, 8 Artemis regions, 34 notable terrain features). You can also click anywhere on the Moon or type any latitude and longitude. |
| Choose a date and time | Date box, play speeds, and a draggable timeline of the next 60 days. |
| Sun and Earth vs the horizon | A 3D surface view with true angular sizes, the real terrain horizon, Earth's phase and libration, and beams to the Sun and Earth. |
| Time to sunset and Earthset | Live countdowns that turn amber and red as the event nears. |
| Power and comms assessment | Sun elevation, daylight duration, Earth-visibility windows, longest night and longest comms blackout. |
| Compare scenarios | Pin up to 4 site-and-date scenarios side by side, with slip buttons (+1 day, +1 week, +1 lunar day) and a best 7-day window finder. |
| South pole terrain | A 3D terrain viewer opened from icons on the Moon, with slope shading, relief exaggeration, Sun shadow, and crater labels. |
| Skill levels | **Explorer** (visual) and **Researcher** (azimuth/elevation, libration, distances, horizon mask, event table, CSV export). |
| Lunar vs Earth conditions | An "Earth sky" toggle adds atmosphere, scattered light and hides the stars. |

### Monte Carlo landing planner

Pick a landing date, a region and a priority. The planner then finds the best landing **site and route** for it.

1. Runs about 55,000 random Earth-to-Moon flights across 7 route families, integrated with RK4 in the Earth–Moon rotating frame (Sun term included).
2. Keeps roughly 500 that actually reach the Moon.
3. Scores each by fuel (delta-v) against the days of continuous Sun **and** Earth after landing, over real terrain.
4. Shows the winner as a route on the 3D globe with the reasons.

Priorities are presets (balanced, comms-first, fuel-first). This is classical Monte Carlo sampling and physics, not machine learning.

### Real spacecraft paths and checks

Real Apollo and other mission paths from JPL Horizons can be overlaid on the globe. The app also checks its own sunrise, sunset, Earthrise and Earthset times against Horizons rise/transit/set output.

## Real data

| Data | Source | Used for |
|---|---|---|
| Sun, Earth and Moon positions, libration, distances, rates | JPL Horizons (DE441) | The sky at every site, the 3D scene, spacecraft paths |
| Sun apparent size, eclipse (Earth in front of the Sun), local solar time | JPL Horizons | Surface view and Researcher readouts |
| Elevation (south polar cap) | NASA LOLA (LRO) gridded data | Pole terrain viewer, horizons, shadows |
| 24 km windows at 30–100 m for 59 sites | NASA LOLA (PDS and Imbrium grids) | High-detail surface patches |
| **Global tiles, any coordinate** | NASA LOLA LDEM_128 (237 m) | Real terrain wherever you click, on the static site too |
| 3D Moon relief and imagery | LOLA global grid, LROC colour mosaic | The globe |

Terrain loads in this order: shipped high-resolution file, then the local server's on-demand LOLA cutter (localhost only), then the global tiles (everywhere).
Terrain is loaded before a site is shown, so the ground never changes under you after a click.

## Run it locally

No build step and no `npm install`. You need Python 3 (the on-demand terrain cutter also uses `numpy` and `scipy`).

```bash
cd lunar-navigator
python3 server.py        # http://localhost:5173
```

Use Chrome, Edge or Safari with WebGL2.

Handy URL options:

| Option | Effect |
|---|---|
| `?notour` | Skip the intro |
| `?site=ar4&land` | Jump to the surface at a site id from `js/sites.js` |
| `?date=2026-11-25T12:00&speed=0` | Start at a date, with the clock paused |

### Large data files are not in git

To keep the repository small, three folders are git-ignored and live only on the machine that built them:

| Folder | Size | How to get it back |
|---|---|---|
| `tex/global/` | about 1 GB | Download NASA's `ldem_128.img` (LOLA, PDS Geosciences) and run `python3 tools/make_global_tiles.py ldem_128.img` |
| `tex/cache/` | grows as used | Created automatically by `server.py` |
| `trek_downloads/` | about 120 MB | Optional raw downloads, `tools/trek_download.py` |

Without `tex/global/`, the app still runs. Clicks on the 59 curated sites use the shipped high-resolution terrain, and other spots use the localhost cutter or generated terrain.

## Deploy

The site is static, so it runs on Firebase Hosting (project `lunar-navigator-2026`).

```bash
firebase deploy --only hosting
```

The localhost-only cutter (`/api/dem`) is not available on the hosted site. There, terrain outside the shipped sites comes from the global LOLA tiles at 237 m.

## Project layout

```
lunar-navigator/
├── index.html, css/style.css     Interface
├── server.py                     Static dev server plus /api/dem LOLA cutter
├── firebase.json, .firebaserc    Hosting config
├── js/
│   ├── main.js                   App orchestration, site handling, UI
│   ├── space.js                  3D Earth–Moon–Sun scene, mission paths, terrain icons
│   ├── surface.js                3D surface view, GPU terrain shadows
│   ├── polarview.js              3D terrain viewer (slopes, relief, shadows)
│   ├── ephemeris.js              Horizons data, Moon/Sun/Earth state, libration
│   ├── analysis.js               Sun/Earth visibility, eclipse, solar time, events
│   ├── terrain.js                LOLA grids, local and global terrain loading
│   ├── shadow.js                 Horizon and shadow ray-marching with lunar curvature
│   ├── trajectory.js             Monte Carlo landing planner
│   ├── montecarlo.js             Landing dispersion simulation
│   ├── charts.js                 Maps and charts
│   ├── sites.js                  The 59 curated sites
│   └── worker.js                 Illumination averages in a Web Worker
├── tex/                          Textures, Horizons data, LOLA terrain
│   ├── local/                    High-resolution site windows
│   └── global/                   Global LOLA tiles (about 1 GB)
├── tools/                        Data-building scripts (Horizons, LOLA, tiles)
└── slides/                       Presentation material
```

## Data-building tools

These scripts regenerate the shipped data. They are not needed to run the app.

| Script | Purpose |
|---|---|
| `tools/horizons_fetch.py`, `horizons_missions.py`, `horizons_rts.py` | JPL Horizons ephemeris, spacecraft paths, rise/set check |
| `tools/lola_local.py`, `local_dems_build.py` | Cut real LOLA windows for any coordinate |
| `tools/make_global_tiles.py` | Build the global tile set from LDEM_128 |
| `tools/trek_download.py` | Bulk download from NASA Moon Trek |

## Accuracy and limits

- There is no atmospheric refraction on the Moon. The horizon is set by terrain and the lunar curvature, and the Sun's upper limb is used for sunrise and sunset, as in Horizons.
- Terrain is real LOLA data everywhere. Away from the shipped sites it is 237 m resolution, so small craters and boulders are not resolved.
- The Monte Carlo uses a simplified three-body model to compare sites, dates and routes. It is a planning aid, not flight navigation.
- Artemis region coordinates are approximate.

## Credits

- NASA LRO LOLA, PDS Geosciences Node and MIT Imbrium for elevation data
- NASA JPL Horizons System for ephemerides
- NASA Scientific Visualization Studio and LROC for imagery
- three.js for 3D rendering (vendored)

Built for the NASA Space Apps Challenge 2026 by Lalithendra Reddy Bhima and Bhavika Bhima.
