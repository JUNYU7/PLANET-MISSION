# PlanetMission · Mars Rover Simulation Platform

Generates Gazebo-ready Mars rover simulation scenarios from real NASA HiRISE terrain data, with live mission execution and evaluation.

## What this is

Ground validation of planetary rover missions has long relied on physical prototypes and test benches — slow, expensive, and unable to reproduce failure modes such as "wheels spin repeatedly on small obstacles" that only emerge under specific terrain coupling. This platform replaces illustrative terrain with meter-level real elevation data, connecting the full chain from *source swap → interpretation → planning → execution → export*, so that wheel-terrain contact relations and slope thresholds carry engineering meaning.

## Features

**Real terrain driven.** Elevation and orthoimagery come entirely from public NASA/USGS planetary remote sensing products. Region configuration is decoupled from source data — adding a new planetary region needs only one config entry, no algorithm changes.

**End-to-end dimensional consistency.** Projection parameters are read from each raster's own coordinate reference system, pixel sizes are measured from the raster rather than taken from nominal values, and vehicle scale is calibrated against real rovers. Every step is traceable to its source.

**Physically grounded obstacle criteria.** Local prominence serves as a second criterion to distinguish boulders from crushable gravel, turning "does this block" from a coarse class check into an interpretable geometric judgment. Measurements show roughly 80% of boulder cells have prominence under half a meter — class-only checks leave wheels spinning in place.

**Three mission types, live.** TRAVERSE, TARGETED_APPROACH and SURVEY_PATH push frame-by-frame to the frontend, keeping vehicle state, terrain interpretation and telemetry on one timeline.

**Gazebo export.** Any region exports to a standalone ROS2 package with terrain mesh, textures, world file and launch script — runnable in Gazebo without this platform.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.9+ / FastAPI / rasterio / numpy / scipy |
| Frontend | React 18 / TypeScript / Vite / three.js |
| Data pipeline | projection → raster window → metrics → downsample → detail synthesis |
| Export | ROS2 / Gazebo package |

## Quick start

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
python start.py
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

### 3. Data

**The repository contains no planetary remote sensing data** (~9.5 GB, and licensing requires obtaining it from the publisher). Download and place into `data/` before first run:

| File | Purpose | Resolution |
|---|---|---|
| `JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif` | Jezero ortho | 0.25 m/px |
| `JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif` | Jezero elevation | 1 m/px |
| `DTEEC_010414_1900_010269_1900_A01.img` | Athabasca elevation (ISIS/PDS) | 1 m/px |
| `PSP_010414_1900_RED_A_01_ORTHO.jp2` | Athabasca ortho | 0.25 m/px |
| `Mars.tif` | Global globe texture | — |

Sources: Mars 2020 TRN HiRISE DTM Mosaic (SOC 006) and MRO HiRISE single-scene stereo products. See the `credit` field of each region in `backend/app/settings.py` for specific attributions.

If `data/` is empty, the service reports the missing filenames and the directories searched at startup, rather than failing when you switch regions.

## Mission types

**TRAVERSE.** Click to place waypoints on terrain, unlimited in number, auto-connected and terrain-following. New points append to the most recent unfinished traverse activity.

**SURVEY_PATH.** Place three non-collinear vertices; the system inserts the centroid automatically at three. The rover drives from the centroid to each vertex in turn, and at each one runs a slope and illumination check before driving the camera toward the centroid — three photos total. Since imaging is a discrete decision, the action space gains an imaging channel beyond velocity and angular velocity.

**TARGETED_APPROACH.** Click once to place a target point; orientation is derived from the approach direction. On arrival the rover first rotates in place to the desired heading, then drives the radar to sweep terrain within a 10 m radius in a downward-looking angle.

## Layout

```
backend/
  app/
    api/          REST and SSE endpoints
    core/         coordinate transforms, raster IO, terrain metrics, rock field, detail synthesis
    env/          rover physics and kinematics
    pipeline/     region processing and Gazebo export
    tools/        scanning and debugging tools
  start.py        service entry
  requirements.txt
frontend/
  src/
    views/         globe view and region view
    components/    telemetry panel, mission panel, photo wall
    scene/         3D scene, rover model, mission markers
  package.json
```

## Troubleshooting

**Terrain looks suspiciously flat.** Check the slope median and relative relief reported during generation first, then compare against the data source. The center point should be chosen with the scanner under `backend/app/tools/` — highest relief among positions passing the missing-pixel threshold — not simply the data center.

**Rover spins on gravel.** If a cell is classed as boulder but has small local prominence, it is in fact crushable gravel. Confirm the obstacle criterion uses local prominence as a second check, and that the threshold matches the vertical precision of the current data source. Vertical precision varies by meters between products; thresholds must be recalibrated per source.

**Dark regions in the 3D scene.** The globe view uses hemisphere light for base illumination plus a weak camera-following directional light for shaping, so no face is left unlit. If dark areas persist, check whether a single directional light with its target at the scene origin was substituted — that illuminates only half the sphere.

## License

Code under [MIT License](LICENSE).

**Terrain data is not in this repository and is not covered by MIT** — it must follow the usage terms declared by NASA/USGS. This platform itself contains no proprietary data from any publisher.

---

中文说明见 [README.md](README.md)
