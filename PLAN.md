# OVERRIDE: Silverstone — F1 2026 Energy Deployment Simulator

Browser-based 3D racing game where the core mechanic is the 2026 F1 energy-deployment
regulation: a fixed per-lap energy budget the player spends anywhere on track — spend it
in one place and it's gone for another. Player vs AI rival at Silverstone; win by
deploying smarter, not driving faster.

Research dossiers (source of truth for all constants): `research/2026-energy-regs.md`,
`research/silverstone.md`, `research/tech-stack.md`, raw geometry in `research/track-data/`.

---

## 1. Game design

### Core loop
1. **Menu / Strategy screen** — interactive Silverstone map with both cars on it.
   The lap is divided into ~20 segments aligned to real track features (pit straight,
   Village complex, Wellington Straight, Maggotts/Becketts, Hangar Straight, …).
   The player paints a **deployment map**: deploy % per segment (0/25/50/75/100%),
   plus harvest behavior (lift-and-coast level) per segment. A live energy ledger shows
   projected MJ spend vs the 8.0 MJ/lap budget and the battery SoC trajectory around the lap.
2. **Race** — 5-lap duel vs an equal-machinery AI rival. Cars auto-drive the racing line
   (real longitudinal physics); the player manages energy:
   - **Deployment map** runs automatically; editable live via the minimap (real teams
     change maps lap-by-lap; drivers rotary-select them).
   - **Manual Override button (SPACE)** — the DRS replacement. Eligible when within
     1.0 s of the car ahead at the Detection Line (after Club, per the real 2026
     British GP setup); grants the override power taper + 0.5 MJ extra harvest for ~a lap.
   - **Deploy aggressiveness trim (↑/↓)** — global multiplier, like real SoC-target rotary modes.
3. **Result screen** — gap history graph, energy usage comparison vs rival, lap times.

### Why this is faithful
Real 2026 racing is exactly this game: teams pre-set percentage deployment maps per
track zone, drivers push-to-pass with Manual Override when within 1 s, and energy spent
attacking on one straight is unavailable to defend on the next ("yo-yo racing",
documented since Melbourne 2026).

---

## 2. Simulation model (all constants from FIA regs / 2026 season reporting)

### Power unit
| Parameter | Value | Confidence |
|---|---|---|
| ICE power | 400 kW (constant available) | reported |
| MGU-K deploy/recover max | 350 kW | FIA confirmed |
| Battery usable window | 4 MJ (≈11.4 s full deploy) | FIA confirmed |
| Harvest cap per lap | 8.0 MJ race / 6.5 MJ quali (Silverstone 2026 values) | reported |
| Override bonus | +0.5 MJ harvest allowance that lap | FIA confirmed |

### Deployment tapers (kW vs v in km/h) — FIA C5.2.8, confirmed
- **Normal:** 350 kW for v ≤ 290; `P = 1800 − 5v` for 290–340; `P = 6900 − 20v` for 340–345; 0 at ≥345.
- **Override:** `P = 7100 − 20v`; full 350 kW to 337.5; 0 at ≥355.
- Attacker in the 337–355 band can have 200–350 kW while defender has ≤100 kW → this IS the overtaking window.
- Ramp-down clipping ≤50 kW/s at Silverstone (7-circuit rule); max step +150 kW on override activation (Miami package).
- 350 kW zones = corner-exit→braking-point acceleration zones; 250 kW cap elsewhere (Miami package).

### Manual Override state machine — FIA B7.2.2/3
- Gap measured once per lap at the **Detection Line** (Silverstone: after T17 Club).
- If gap < 1.0 s → armed at **Activation Line** (onto pit straight), available until next AL crossing.
- Disabled: before leader crosses DL on lap 1, under Safety Car. No defender restriction.

### Recovery (place-dependent — this is the strategy depth)
- Braking regen: up to 350 kW during braking events (8 braking events at Silverstone).
- Lift-and-coast regen: player-controlled per segment; costs lap time, gains energy.
- Superclip harvest at full throttle: 250–350 kW, used in designated zones (Maggotts/Becketts
  is the real 2026 "charging station" at Silverstone).

### Chassis / aero
- Mass ~800 kg incl. driver/fuel · lateral grip ~4.5–5 g (downforce-dependent with v²)
- Active aero: X-mode (low drag) auto-engages in the 4 real Silverstone Straight-Mode zones
  (S/F, Wellington, National, Hangar); Z-mode elsewhere. Lift-off drops X-mode.
- Slipstream: CdA reduction when within ~1 s behind a car → tow + override = the pass.

### Physics engine: none — custom 1D point-mass
- Position = arc-length s along spline; `m·dv/dt = P(v,deploy)/v − ½ρCdA(mode)v² − Crr·mg − F_brake`
- Corner cap: precomputed `vLimit(s)` from curvature κ and lateral-g envelope + backward braking pass.
- Semi-implicit Euler, fixed dt = 1/120 s, decoupled from render; single seeded PRNG → fully deterministic.

### Calibration targets (tests assert these)
- Quali-trim lap ≈ 1:28 (2026 pole: 1:28.111, Antonelli) · race pace 1:31–1:34
- Top speed ~320–340 km/h end of Hangar with deploy; ~50 km/h cliff when depleted
- Corner apex speeds within ±10 km/h of research table (Village ~130, Loop ~100, Copse ~295…)
- Energy ledger: full-deploy lap spends ≈ 8 MJ + SoC delta; never exceeds caps
- Taper unit tests: P(300)=300 kW, P(340)=100 kW, P(345)=0; override P(337.5)=350, P(355)=0

---

## 3. Track: real Silverstone geometry
- Source: TUMFTM racetrack-database CSV (1,178 pts, x/y meters + per-point widths,
  5,886.8 m ≈ 0.07% error vs official, starts at real S/F line).
- Pipeline: CSV → closed centripetal Catmull-Rom → arc-length table (~1–2 m samples storing
  pos/tangent/lateral/κ/widths) → O(1) `trackAt(s)` → ribbon BufferGeometry (flat up-vector,
  not Frenet), kerb ribbons where |κ| high, deploy-zone color overlays, 2D canvas minimap
  from same data. 18 named corners with distances from the research corner table.

## 4. Rendering & presentation
- **Three.js r185, WebGLRenderer** (not WebGPU — headless-Chrome testability), TypeScript + Vite.
- Stylized-broadcast look: track ribbon + kerbs + painted run-off, instanced grandstands/trees,
  Wing pit building silhouette, gradient sky (screenshot-stable). Cars: stylized 2026 F1 built
  from primitives (halo, wings, distinct liveries); CC-BY glTF swap-in is a later polish option.
- Cameras: TV chase cam (default), onboard, trackside; HUD is DOM overlay (Puppeteer-assertable):
  SoC %, live kW, lap budget bar, gap + detection countdown, override indicator, speed/gear,
  lap & sector times, minimap with cars + zones.

## 5. AI rival
Same physics & budget. Ships with a competent default deployment map (deploy out of slow
corners onto Wellington/Hangar, harvest in Maggotts/Becketts, defend pit straight when
attacked). Difficulty = quality of its map + override timing. No rubber-banding: equal
machinery, strategy decides.

## 6. Architecture (16 modules, sim/render boundary — see research/tech-stack.md)
`src/sim/` (zero Three.js imports — headless-testable): track.ts, physics.ts, energy.ts,
override.ts, aiDriver.ts, race.ts, rng.ts · `src/render/`: scene.ts, trackMesh.ts, car.ts,
cameras.ts, environment.ts · `src/ui/`: hud.ts, strategyScreen.ts, minimap.ts, menu.ts ·
`src/debug.ts` (window.__game: getState/step/setTimeScale/setSeed/setDeploy/errors[]).

## 7. Testing strategy (continuous, not end-loaded)
- **Vitest** on sim core: taper formulas, energy ledger conservation, override state machine,
  vLimit/braking, lap-time calibration regression, determinism (same seed → identical state hash).
- **Puppeteer / chrome-devtools MCP** E2E: boot → menu → paint map → race → assert HUD values
  via `window.__game.getState()` at deterministic ticks; screenshot checks at fixed seed+pause;
  console-error gate; FPS budget check.

## 8. Build phases (each gated by tests)
| Phase | Deliverable | Gate |
|---|---|---|
| 0 | Scaffold (Vite+TS+Three), track data pipeline | CSV→spline roundtrip test, minimap renders |
| 1 | Headless sim core (physics, energy, tapers, vLimit) | All unit tests + lap-time calibration |
| 2 | 3D track + environment + cameras | Visual E2E screenshot, 60 fps |
| 3 | Cars on track + HUD | Deterministic replay E2E |
| 4 | Strategy screen (paint deploy map) + live boost + override | Override state-machine E2E |
| 5 | AI rival + race logic (start, gaps, detection line, result) | Full race E2E: beatable-but-competitive |
| 6 | Menu, polish, audio (WebAudio engine hum), balancing | Lighthouse/perf pass, full E2E suite |

## 9. Future (explicitly out of scope for v1)
More tracks (data pipeline is track-agnostic by design), qualifying mode, multiplayer,
weather, tire model, full manual driving mode.
