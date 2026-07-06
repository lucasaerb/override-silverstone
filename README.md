# OVERRIDE: Silverstone

A browser-based 3D Formula 1 simulator built around the **2026 F1 energy-deployment
regulations**. Same car, same grip as your rival — the race is won on *energy strategy*.
You have roughly one lap's worth of electrical energy to spend anywhere on track; pour it
into the straights where overtakes happen, bank it where you're grip-limited, and get within
1.0 s of the car ahead to unlock **Manual Override** (the 2026 DRS replacement) and strike.

Cars drive the racing line automatically with real longitudinal physics — you're the driver
managing energy: pre-plan a deployment map, then **push-to-deploy live** (SPACE) at the
moments you choose, watching a full race-engineer telemetry readout. Beat the AI from P2 in
a 5-lap duel on strategy, not pace.

## The 2026 regulations, modeled faithfully

Every constant comes from the FIA 2026 Technical Regulations (Section C, Issue 12) and
Sporting Regulations (Section B, Issue 05), cross-checked against 2026-season reporting.
Full provenance is in [`research/2026-energy-regs.md`](research/2026-energy-regs.md).

- **350 kW MGU-K deploy**, tapering above 290 km/h to zero at 345 km/h (FIA C5.2.8.i:
  `P = 1800 − 5v` then `6900 − 20v`). The widely-quoted "zero at 355" is a superseded draft —
  355 is the *override* cutoff.
- **Manual Override**: holds full 350 kW to 337.5 km/h, zero at 355 (`P = 7100 − 20v`) — so
  within the 337–355 km/h band an attacker has 200–350 kW while the defender's normal-mode
  power is already dead. Armed only within **1.0 s** of the car ahead at the detection line
  (after Club), active from the activation line onto the pit straight.
- **8.0 MJ/lap harvest cap** (Silverstone race value; 6.5 MJ qualifying), **4 MJ** usable
  battery window, **+0.5 MJ** override bonus, **50 kW/s** ramp-down "clipping".
- **Percentage deployment maps**: you set deploy % per track zone (like the real steering-wheel
  map dials), and superclip-harvest (0% deploy at full throttle) through the grip-limited
  Maggotts/Becketts complex — Silverstone's real 2026 "charging station".

The result is the documented **"yo-yo racing"** dynamic: spend to pass on one straight, get
re-passed on the next when your battery is flat. The result screen's gap-history chart shows
the lead swinging back and forth all race.

## Learn optimal strategy from evidence

The point isn't just to race — it's to *understand* where energy buys lap time. A track-agnostic
optimizer ([`src/sim/optimizer.ts`](src/sim/optimizer.ts)) solves the constrained optimal-control
problem — "where should I deploy and recover to minimise lap time?" — by coordinate ascent over a
no-refill multi-lap race simulation, so the physics itself enforces the energy balance (over-deploy
and your battery drains and later laps collapse to engine pace). It runs off the main thread in a
Web Worker (~2 s) and drives an evidence-and-coaching layer:

- **Deploy-value heat-map** — the track is coloured by how much lap time deploying in each zone
  saves. Bright green (Hangar, the corner-exits, Becketts→Hangar) = spend here; red (the
  Maggotts/Becketts charging complex, short straights into braking) = wasted. You *see* where to
  deploy before you're told.
- **Solve Optimal + coach** — one click computes the optimal map; the screen shows your projected
  lap vs optimal, "you're leaving X.Xs on the table", the biggest per-zone gains phrased as
  coaching, and a dashed **optimal ghost trace** on your speed chart so you see where you lose time.
- **Post-race debrief** — after the flag, an engineer's debrief compares your energy plan to
  optimal: time left on the table, and a ranked per-zone breakdown of where you deployed well,
  wasted energy, or missed cheap harvest.

Because the optimizer and evidence layer read only the generic track structure and the shared lap
sim — zero Silverstone-specific code — **every future circuit added as a centreline CSV gets
optimal-strategy solving and coaching for free.**

## Silverstone, from real telemetry

The track is built from the [TUMFTM racetrack-database](https://github.com/TUMFTM/racetrack-database)
Silverstone centerline (1,178 points + per-point track widths), 5,887 m — 0.07% off the
official length. A minimum-curvature optimizer computes the racing line within the real
track-width corridor. Calibrated to the **2026 pole of 1:28.111** (the sim runs 1:28.18);
top speed ~337 km/h down Hangar Straight, ~38 km/h slower on a depleted battery.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # production bundle to dist/
npm run preview    # serve the built bundle
npm test           # 121 unit tests (physics, energy, override, projection, race, optimizer)
npm run test:e2e   # headless Puppeteer end-to-end smoke test (build + full flow)
```

Requires Node 20+. No server or API keys — it's fully static.

## Game modes

A first-run **click-through tutorial** teaches the core loop (re-openable any time via the
**?** button). From **Menu → START** you pick a mode:

- **Time Trial** — solo hot-lap against your own saved **ghost**; keep retrying to beat your best.
- **Optimal Lap** — the sim solves the fastest deployment strategy, then drives the perfect
  lap while you watch and learn.
- **Overtake Challenge** — start 1.0 s behind a strong (near-optimal) rival over 3 laps; use
  your within-1-second **Manual Override** edge (extra power + 0.5 MJ) to pass and hold the lead.
- **Head-to-Head (2–4 players)** — race up to three friends with a share code. Enter your
  name, pick the lap count, and everyone lines up on a colour-coded grid with floating name
  labels. **No server hosts the session**: WebRTC runs peer-to-peer (via trystero's public
  relays for cross-device signaling, or BroadcastChannel for tabs on the same machine). Same
  car, same grip — the better energy strategist wins. Host-authoritative netcode keeps every
  car in sync; the race ends on a full finishing **classification** with a clear winner.

Every race starts with a real **F1 five-red-lights** launch sequence; grandstands are packed
with crowds, and the **Landostand** stands over Stowe in Lando's yellow-and-black.

## How to play

1. **Menu → START → pick a mode.**
2. **Strategy screen** — paint your deployment map on the Silverstone map:
   - **Left-click** a zone to cycle its deploy % (0 → 25 → 50 → 75 → 100) and **select** it.
   - **Right-click** a zone to cycle its harvest/lift level (bank energy where you brake).
   - The side panel runs a **real headless lap simulation** on every edit and shows the
     projected lap time, energy vs the 8.0 MJ budget, top speed, the **speed-around-the-lap
     chart** and your State-of-Charge trace.
   - Click a zone to open the **zone inspector**: its length, corner apex speeds, a zoomed
     **speed chart for that section**, deploy/lift chips, and a "Δ vs no-deploy here" readout
     so you can see exactly what deploying in that spot buys you.
   - Toggle **Show Deploy Value** to see the whole track heat-mapped by where energy pays off,
     hit **Solve Optimal** to let the sim compute the fastest map, and read the **coach** —
     "you're leaving X.Xs on the table" with the biggest fixes and an optimal ghost trace.
   - Try the **Hunt** / **Balanced** / **Clear** presets; pick rival difficulty, race length,
     and seed (races are deterministic and shareable).
3. **Race** — you're the driver managing energy. Hold **SPACE** to push-to-deploy at the
   moments you choose; the **RACE ENGINEER** telemetry panel (toggle with **T**) shows your
   deploy mode, live power vs the speed taper, a rolling speed/power trace, battery + lap
   budget, the Manual Override eligibility rule with your live gap to the car ahead, tow,
   throttle/brake and sector splits.

   | Key | Action |
   |-----|--------|
   | **SPACE** (hold) | **Push-to-deploy** — full MGU-K power on demand (enhanced when Override is armed within 1.0 s of the car ahead) |
   | **T** | Toggle the detailed telemetry panel |
   | **↑ / ↓** | Deploy aggressiveness trim |
   | **M** | Live strategy overlay — re-map zones mid-race, racing continues |
   | **C** | Cycle camera (chase / onboard / trackside) |
   | **Esc** | Pause |

4. **Result** — final gap, per-lap times, gap-history and per-lap energy charts.

A well-built strategy beats the balanced AI by ~0.5 s over 5 laps; an empty map loses by ~2.2 s.

## Architecture

Clean split between a headless-testable **sim layer** (zero Three.js imports) and the
**render/UI layer**:

```
src/sim/     track · racingLine · physics · energy · override · race · aiDriver
             projection · optimizer            (all headless, track-agnostic)
src/render/  scene · trackMesh · environment · carModel · cameras
src/ui/      hud · telemetry · minimap · strategyScreen · resultScreen · menuScreen
             trackMap · speedChart · banners · audio
             optimizer.worker · solverClient   (off-main-thread solving)
src/debug.ts window.__game — deterministic control surface for the E2E harness
```

- **No physics engine.** A custom 1D point-mass integrator along the track's arc length
  (semi-implicit Euler, fixed `dt = 1/120`) with drag, downforce-dependent cornering limits,
  braking, and the full FIA power tapers. Deterministic — the only randomness is a seeded PRNG,
  so a given seed replays tick-for-tick. Runs ~3,700× realtime, which is what lets the strategy
  screen project a full lap in a few milliseconds.
- **Rendering** is Three.js r185 (WebGL) — a spline-ribbon track mesh with generated
  asphalt/kerb textures, instanced environment, 2026-proportioned cars built from merged
  primitives (~5.7k triangles, 4 draw calls each), three broadcast cameras.
- **Testability**: `window.__game` exposes `getState / step / setTimeScale / setSeed /
  setDeploy / setBoost / setCamera / goto / getProjection / setMap`, so the whole game is
  drivable deterministically from Puppeteer / Chrome DevTools.

## Roadmap

More tracks (the pipeline is track-agnostic — drop in another centerline CSV), qualifying
mode, multiplayer, a tyre/weather model, and a full manual-driving mode.

---

Research dossiers for the regulations, circuit data, and stack decisions live in
[`research/`](research/); the full build plan is in [`PLAN.md`](PLAN.md).
