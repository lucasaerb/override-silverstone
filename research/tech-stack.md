# Tech Stack & Architecture Research — Browser F1 Energy-Strategy Racer

Date: 2026-07-04. Target: Chrome, no server, Vite + TypeScript, testable via Puppeteer/Chrome DevTools MCP.
Game concept: 3D Silverstone, player vs AI on rails (auto racing line), player's core mechanic is **2026-rules hybrid energy deployment** with real longitudinal physics.

---

## 1. Renderer Choice: Three.js (r185) — recommended

### Current state of the field (verified July 2026)

| Option | Current version | Verdict |
|---|---|---|
| **Three.js** | **r185** (npm `three@0.185.0`, released ~July 1 2026) | **Chosen** |
| Babylon.js | 9.14.0 (9.0 shipped March 2026) | Capable but overkill |
| Phaser | 3.x / 4 beta line | 2D only — rejected |

**Phaser, honestly assessed:** Phaser is a 2D engine. A top-down 2D version of this game would work mechanically, but the brief explicitly asks for an "incredible 3D game" — cinematic chase cam, a 3D Silverstone with kerbs and grandstands, visible car-vs-car overtakes. That experience is not achievable in Phaser without embedding Three.js anyway. 3D is worth it here: the scope is contained (one track, two cars, on-rails), so the classic "3D is 10x harder" penalty mostly doesn't apply — we skip the hard parts (free steering, collision, 3D physics).

**Babylon.js 9:** batteries-included (Frame Graph, clustered lighting, node particle editor), great engine, but a significantly larger bundle and a framework-ish API. For a single-scene game with ~10 meshes and custom geometry, Three.js's smaller surface area and enormous example corpus win. Nothing in Babylon 9's headline features (geospatial rendering, animation retargeting) is relevant here.

### Three.js r185 — what to know (recent breaking changes)

- **Addons paths:** long stable — import from `three/addons/...` (e.g. `three/addons/utils/BufferGeometryUtils.js`). The old `three/examples/jsm/...` deep paths still resolve but `three/addons` is the canonical alias with Vite.
- **`THREE.Clock` was deprecated in r183.** Use `Timer` from `three/addons/misc/Timer.js` or plain `performance.now()`. We use our own fixed-timestep accumulator anyway.
- **WebGPURenderer status:** production-capable since ~r171; imported from `three/webgpu`; auto-falls back to WebGL2; comes with TSL (Three Shading Language) and the node material system. r183 renamed `PostProcessing` → `RenderPipeline`. WebGPU is now Baseline in all major browsers (Safari 26 shipped it).
- **Should we default to WebGPURenderer? No — use `WebGLRenderer`.** Reasons specific to this project:
  1. `WebGLRenderer` is **not deprecated** and remains the recommended stable path for classic-material scenes like ours (docs still say WebGPURenderer can have missing features / worse perf for some setups).
  2. **Testability:** headless Chrome under Puppeteer/CDP has bulletproof WebGL2 support (SwiftShader software fallback included). WebGPU in headless/CI is still flag-and-driver dependent — a real risk for the required Puppeteer test loop.
  3. Our scene is trivial for WebGL2 (a few thousand triangles, 2 cars, instanced crowd). WebGPU's wins (massive draw calls, compute) don't apply.
  4. Migration later is nearly mechanical if ever wanted (swap renderer import, adopt RenderPipeline for post).

**Decision: Three.js r185 + `WebGLRenderer`, TypeScript, Vite. No React — vanilla TS keeps the game loop and DOM HUD dead simple.**

---

## 2. Track From Centerline (TUMFTM format → 3D mesh)

### Source data
- **TUMFTM racetrack-database** (github.com/TUMFTM/racetrack-database): CSV per track, columns `x_m, y_m, w_tr_right_m, w_tr_left_m` — smoothed centerline + per-side widths. **Silverstone is included** (F1 folder). Repo is LGPL-3.0; we consume the CSV as data (bake it into a TS module, credit the source in README). Racelines (min-curvature `x_m,y_m`) also available if we want a distinct racing line vs centerline later.
- Data is 2D (flat) — which settles the frame question below.

### Pipeline (concrete Three.js techniques)

1. **Spline:** `new THREE.CatmullRomCurve3(points, /*closed*/ true, 'centripetal')`. Centripetal parameterization avoids loops/overshoot on unevenly spaced samples. Points are `(x, 0, y)` (map track XY → Three XZ, Y-up).

2. **Arc-length parameterization (the s-coordinate):** don't position cars by the raw curve parameter `u` (not proportional to distance). Build a lookup table once:
   - Sample the curve densely (e.g. every ~1–2 m; Silverstone ≈ 5.9 km → ~3–6k samples).
   - `curve.getLengths(n)` / `curve.getUtoTmapping(u, distance)` do this internally, but a hand-rolled table is better because we attach *more* per-sample data: `{ s, pos, tangent, lateral, kappa, wLeft, wRight, vLimit }`.
   - Runtime query `trackAt(s)`: `s mod trackLength`, binary search (or direct index since spacing is uniform), lerp between samples. O(1), allocation-free (write into scratch vectors).

3. **Frames — flat up-vector, NOT Frenet:** Frenet frames flip the normal at curvature inflections (every S-curve — Maggotts/Becketts would twist the ribbon violently). Since the data is flat, use:
   - `up = (0,1,0)`, `lateral = normalize(cross(up, tangent))` (points left of travel).
   - If elevation is ever added, upgrade to rotation-minimizing / parallel-transport frames (`curve.computeFrenetFrames` in Three actually does a parallel-transport-style sweep, still needs care) — not needed now.

4. **Curvature κ(s):** finite differences on heading: `psi[i] = atan2(tz, tx)`, `kappa[i] = wrapAngle(psi[i+1] - psi[i-1]) / (s[i+1] - s[i-1])`; light smoothing pass (moving average over ~5 samples). κ drives both corner speed limits (physics) and kerb placement (art).

5. **Ribbon mesh (custom `BufferGeometry`):** for each sample `i`:
   - `left_i = pos + lateral * wLeft`, `right_i = pos − lateral * wRight` → two vertices per sample, two triangles per segment, closed loop (wrap indices).
   - Normals all `(0,1,0)`. Set `position`, `normal`, `uv`, index buffers directly — no `ExtrudeGeometry`/`TubeGeometry` (wrong topology for a flat variable-width ribbon).
   - **UVs:** `u ∈ [0,1]` across the track (right→left), `v = s / repeatLen` (e.g. repeatLen = 20 m) with a `RepeatWrapping` asphalt texture. A center dashed line, racing-line hint stripe, or DRS-zone tint can be painted in the fragment via a second texture or just vertex colors keyed off `u` and per-segment flags.
   - **Kerbs:** separate thin ribbons (~1.5 m wide) hugging the outer edge where `|kappa| > threshold`, alternating red/white via `v`-striped texture or per-segment vertex colors, raised ~4 cm.
   - **Edges/walls/grass:** more ribbons offset further out: grass ribbon (green, wide), optional gravel ring at big braking zones, low barrier ribbon (vertical quad strip) for visual containment.

6. **Cars positioned by (s, d):** `pos = trackAt(s).pos + lateral * d` where `d` is lateral offset from centerline (lane). Heading = tangent (+ small yaw from `d` rate for visual flair). This is the whole "on rails" transform. Overtakes = animate `d` between lanes.

---

## 3. Physics: custom 1D point-mass integrator — no physics engine

**Verdict: Rapier/cannon-es are the wrong tool.** They solve 3D rigid-body contact — we have no free bodies, no collisions, no suspension. Wrapping a rigid body just to constrain it back onto a spline adds nondeterminism, WASM loading (Rapier), and tuning pain for zero benefit. The correct model is a classic **quasi-steady-state longitudinal simulation along s** — ~200 lines, exact, fully deterministic, unit-testable headlessly.

### Model (per car, state = `{ s, v, E_batt, E_harvestedThisLap }`)

Forces (N), semi-implicit Euler at fixed dt:

```
F_drive  = min( P_total / max(v, v_eps),  mu_long * N_load )      // power- and traction-limited
P_total  = P_ICE + P_deploy(v, deployHeld, overrideActive)
F_drag   = 0.5 * rho * CdA * v^2
F_roll   = Crr * m * g
F_brake  = brakingActive ? mu_long * N_load : 0                    // ~5g at speed (aero-assisted)
N_load   = m * g + 0.5 * rho * ClA * v^2                           // weight + downforce
a        = (F_drive - F_drag - F_roll - F_brake) / m
v       += a * dt;  s += v * dt
```

**Cornering (the "rails" constraint):** precompute a **speed-limit profile** `vLimit(s)`:
1. Pure lateral limit: `v_lat(s) = sqrt(a_lat(v) / |kappa(s)|)` where `a_lat(v) = mu_lat * N_load(v) / m` (downforce-dependent — solve the implicit equation once per sample by fixed-point iteration, or start with constant 4.5 g and upgrade). Straight sections (`kappa≈0`) → ∞ (cap at v_max ≈ 360 km/h).
2. **Backward pass** (braking): sweep s in reverse, `v[i] = min(v_lat[i], sqrt(v[i+1]^2 + 2*a_brake(v)*ds))`.
3. Forward pass isn't baked in — acceleration emerges from the live integrator; the sim just **clamps `v ≤ vLimit(s)`** each step and auto-brakes when approaching a lower-limit zone (compare needed decel vs available). The car "drives itself" longitudinally; the player only modulates `P_deploy` and thereby straight-line speed, overtaking windows, and battery state.

**2026 hybrid energy model (the game mechanic — real rule numbers, verified):**
- MGU-K deploy power: **350 kW**, ICE ≈ 400 kW (~536 hp).
- Deploy **tapers from 290 km/h to zero at 355 km/h** (linear ramp) — makes deploy most valuable at corner exit, exactly the strategic texture we want.
- **Manual Override (overtake mode):** when within ~1 s of the car ahead, full 350 kW held to **337 km/h** + **0.5 MJ** extra allowance — this is the player's attack button #2.
- Harvest under braking at up to 350 kW, capped at **8.5 MJ recovered per lap**; battery store 4 MJ.
- Minimum car mass **768 kg** → use m ≈ 800 kg with driver/fuel.

**Constants table (tunable in `config.ts`):**

| Constant | Value | Notes |
|---|---|---|
| m | 800 kg | 2026 min 768 kg + driver/fuel margin |
| P_ICE | 400 kW | 2026 ICE |
| P_deploy_max | 350 kW | taper 290→355 km/h; override full→337 km/h |
| E_batt | 4 MJ | deploy store |
| Harvest cap | 8.5 MJ/lap | 2026 rules |
| rho | 1.225 kg/m³ | |
| CdA | ~1.2 m² | 2026 cars are lower-drag; 1.0–1.5 plausible |
| ClA | ~4.0 m² | downforce area |
| mu_lat | ~1.7 | → 4–5 g lateral with downforce at speed |
| mu_long | ~1.8 | traction/braking |
| Crr | 0.012 | rolling resistance |

**Optional depth (cheap, recommended):** slipstream — reduce effective CdA ~20–30% when within ~15 m behind the other car. Combined with override mode this creates authentic "tow + deploy" overtakes.

Integration: **semi-implicit Euler, dt = 1/120 s** fixed. No RK4 needed (forces are smooth; the clamp is the dominant nonlinearity).

---

## 4. Car Models & Assets

### Recommended: primitive-built stylized F1 car (primary), glTF upgrade path (optional)

**Building from Three.js primitives is genuinely effective** for an F1 silhouette and is the recommended default:
- The F1 shape decomposes cleanly: tapered nose (`CylinderGeometry` 4-sided or scaled `BoxGeometry`), monocoque + sidepods (boxes with scaled vertices), halo (`TorusGeometry` arc + cylinder strut), front/rear wings (thin boxes + endplates), wheels (`CylinderGeometry`, black + rim disc), driver helmet (`SphereGeometry`). ~15–20 meshes in a `Group`, or merged via `BufferGeometryUtils.mergeGeometries` per material for 2 draw calls/car.
- **Full control of team liveries** (player vs AI colors), zero license text, zero loader code, zero file size, looks intentionally stylized rather than cheaply realistic — at chase-cam distance this reads great, especially with `MeshStandardMaterial` + environment lighting and a soft shadow blob.
- Deterministic and instantly testable (no async asset load in the critical path).

**glTF fallback/upgrade sources (all verified available):**
- Sketchfab CC-BY low-poly F1 models (attribution required, downloadable glTF): "Low Poly-F1" by salasilma13 (12.6k tris), "basic Lowpoly F1 Car V1" by arthihalder (20.9k tris), "low poly f1" by malik-alqarasinih (game-optimized, Jan 2026).
- **Quaternius Cars bundle** — CC0, glTF, but generic sports cars, no open-wheeler.
- **Kenney Car Kit** — 45 CC0 models, same caveat: no F1 car.
- Poly Pizza aggregates the CC0 sets for quick browsing.
- Net: **no good CC0 open-wheeler exists**, which further supports primitives-first; CC-BY Sketchfab models are the polish-phase option (add attribution line in HUD/README).

**Environment (low-poly, instanced):**
- Grandstands: box stacks along key corners (Stowe, Luffield, start/finish straight) with `InstancedMesh` of tiny colored boxes/quads as crowd (thousands of instances, 1 draw call).
- Trees: instanced cone+cylinder or camera-facing billboards.
- Sky: big inverted sphere with vertex-color gradient (cheap, deterministic) — skip HDRI to keep tests pixel-stable; `HemisphereLight` + one `DirectionalLight` with a single shadow-casting region around the cars (or fake blob shadows — cheaper and stable).
- Ground: large green plane; the track ribbons sit 1–2 cm above (polygonOffset to avoid z-fighting).

---

## 5. Game Loop & UI

- **Fixed-timestep sim decoupled from render** (canonical accumulator):
  ```ts
  renderer.setAnimationLoop((tMs) => {
    acc += Math.min(tMs - last, 250) * timeScale; last = tMs;
    while (acc >= DT_MS) { sim.step(DT); acc -= DT_MS; }
    renderState.interpolate(sim.prev, sim.curr, acc / DT_MS);  // s, d, v lerped
    render();
  });
  ```
  `timeScale` is a first-class variable (slow-mo replays + fast-forward tests). Sim is pure TS with zero Three imports → runs headless in Vitest.
- **HUD: HTML/CSS overlay over the canvas — not in-canvas.** Absolutely-positioned DOM layer: ERS battery bar, deploy indicator, speed, lap/gap timing, override availability, big touch "DEPLOY" button (bottom-right). DOM wins because: crisp text at any DPI for free, CSS transitions for bar animations, and — critically — **Puppeteer can assert HUD state via selectors** instead of pixel-reading the canvas.
- **Minimap:** small 2D `<canvas>` (e.g. 200×200), drawn from the same centerline array: fit-to-bounds transform once, stroke the polyline once to an offscreen canvas, per-frame just blit + draw 2 car dots from `trackAt(s)`. Update at ~15 Hz, not every frame. Highlight deploy-worthy zones (long straights) on it — it doubles as the strategy UI.
- **Input:** `keydown/keyup` **Space = hold to deploy**, `O` or `Shift` = override when armed; `pointerdown/pointerup` on the DEPLOY button for touch (also `touch-action: none`). Guard `event.repeat`, `preventDefault` on Space (page scroll). Input layer just sets `input.deployHeld: boolean` read by the sim — trivially scriptable from tests.

---

## 6. Testability (Puppeteer / Chrome DevTools MCP)

Design for testing from day 1 — the sim/render split above is 80% of it.

- **Debug API on window** (always installed; harmless in prod):
  ```ts
  window.__game = {
    version, ready: Promise<void>,
    getState: () => ({ player: {s,v,kmh,battMJ,deploying,lap,lapTimeMs},
                       ai: {...}, gapSec, raceTime, phase }),   // plain JSON-able
    setTimeScale: (x: number) => void,       // 0 = pause, 10 = fast-forward
    step: (nTicks: number) => void,          // advance sim manually while paused
    setSeed: (n: number) => void, reset: () => void,
    setDeploy: (held: boolean) => void,      // bypass DOM input
    setCamera: (preset: 'chase'|'tv'|'top') => void,
    errors: string[],                        // window.onerror / unhandledrejection sink
  };
  ```
- **Determinism:** all randomness (AI deploy-strategy jitter) through one seeded PRNG (mulberry32); fixed dt; no `Math.random`, no `Date.now` in sim. Same seed + same input script ⇒ identical race, tick-for-tick — enables golden-state regression tests (`step(12000); expect(getState())` snapshots).
- **Puppeteer patterns:**
  - Launch against `vite preview`/`vite dev`; `await page.evaluate(() => window.__game.ready)`.
  - Drive via `page.keyboard.down('Space')` (real input path) *and* via `__game.setDeploy(true)` (sim path) — test both layers.
  - Fast races: `setTimeScale(20)` then poll `getState().phase === 'finished'`.
  - Assert HUD through DOM selectors (`#ers-bar`, `#gap`), not canvas pixels.
  - **Screenshots:** with fixed seed + `setCamera('tv')` + paused sim (`setTimeScale(0)`), frames are stable → screenshot diffing works for visual regressions (track rendered, cars visible, kerbs present). Headless Chrome renders WebGL2 via GPU or SwiftShader fallback — another reason WebGLRenderer beats WebGPURenderer here. Prefer structural assertions (renderer.info.render.triangles > N via a `getRenderStats()` debug call) over strict pixel equality across machines.
  - Console/error hygiene: assert `__game.errors.length === 0` and no `pageerror` events after a full fast-forwarded race.

---

## ARCHITECTURE RECOMMENDATION

**Stack:** TypeScript + Vite + `three@0.185.0` (`WebGLRenderer`). No physics engine. No UI framework. No other runtime dependencies. Dev deps: `vitest` (headless sim tests), `puppeteer` (e2e), optionally `typescript` strict mode. Everything static — `vite build` output runs from any file server; no backend.

### Module breakdown

```
f1_project/
  index.html                     # canvas + HUD DOM skeleton
  src/
    main.ts                      # bootstrap, fixed-timestep loop, wiring
    config.ts                    # all physics/game constants (single tuning surface)
    track/
      silverstone.ts             # baked TUMFTM centerline data [x,y,wr,wl][] + credit
      spline.ts                  # CatmullRom sampling, arc-length table, trackAt(s),
                                 # curvature, flat-up lateral frames
      velocityProfile.ts         # vLimit(s): lateral limit + backward braking pass
    sim/
      car.ts                     # CarState + 1D integrator (forces, clamp to vLimit)
      energy.ts                  # 2026 ERS: deploy taper, override, harvest, caps
      ai.ts                      # AI deploy policy (zone-based + seeded jitter)
      race.ts                    # laps, gaps, override eligibility, lane offsets,
                                 # overtake resolution, phase machine, PRNG
    render/
      scene.ts                   # renderer, lights, sky, ground, resize
      trackMesh.ts               # ribbon BufferGeometry, kerbs, walls, UVs
      carModel.ts                # primitive-built F1 car factory (livery params)
      environment.ts             # instanced grandstands/crowd/trees
      cameraRig.ts               # chase/TV/top cameras, smoothing
    ui/
      hud.ts                     # DOM HUD: ERS bar, speed, gap, laps, deploy btn
      minimap.ts                 # 2D canvas map from centerline + car dots
    input.ts                     # keyboard/pointer → { deployHeld, overridePressed }
    debug/testApi.ts             # window.__game
  tests/
    sim.spec.ts                  # vitest: physics invariants, lap-time sanity,
                                 # energy accounting, determinism golden states
    e2e.spec.ts                  # puppeteer: boot, race fast-forward, HUD, screenshot
  research/tech-stack.md         # this document
```

Key boundary: **`sim/` and `track/` import nothing from Three** (spline math is ~30 lines of vec2 or uses Three's math classes only — if so, still fine headless since three's math runs in Node). Render layer reads sim state; never the reverse.

### Build order

1. **Track data + spline core** — bake Silverstone CSV to `silverstone.ts`; implement arc-length table, `trackAt(s)`, curvature; verify with the **minimap** (fastest possible visual proof, no 3D yet).
2. **Physics headless** — `car.ts`, `velocityProfile.ts`, `energy.ts`; vitest: top speed ≈ 340–360 km/h with deploy, Silverstone lap ≈ 85–95 s, battery never negative, harvest cap respected, determinism snapshot.
3. **3D scene + track mesh** — renderer, lights, ribbon + kerbs; fly-over camera. First "wow" checkpoint.
4. **Cars + chase camera** — primitive car factory, place both cars by (s, d), camera rig. Watch the AI lap on its own.
5. **Player mechanic** — input, ERS deploy/taper/harvest live, HUD (battery bar is the heart of the game), minimap embedded.
6. **Race layer** — AI deploy policy, gaps, override mode, slipstream, lane-offset overtakes, lap counting, win/lose screen.
7. **Test harness hardening** — `__game` API (built incrementally from step 2), puppeteer e2e: seeded race fast-forward, HUD assertions, screenshot checks.
8. **Polish** — grandstands/crowd instancing, DRS-zone/deploy-zone track tinting, engine audio (WebAudio osc pitch from v), speed lines, better liveries or CC-BY glTF swap-in.

### Sources
- three.js releases: https://github.com/mrdoob/three.js/releases (r185 current; r183: Clock deprecated, PostProcessing→RenderPipeline)
- three.js migration guide: https://github.com/mrdoob/three.js/wiki/Migration-Guide
- WebGPURenderer docs/manual: https://threejs.org/docs/pages/WebGPURenderer.html , https://threejs.org/manual/en/webgpurenderer.html
- Three.js 2026 state overview: https://www.utsubo.com/blog/threejs-2026-what-changed , https://www.utsubo.com/blog/webgpu-threejs-migration-guide
- Babylon.js 9.0: https://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0/ , npm babylonjs (9.14.0)
- TUMFTM racetrack database (Silverstone, CSV format): https://github.com/TUMFTM/racetrack-database
- 2026 F1 power unit rules (350 kW MGU-K, taper 290→355 km/h, override to 337 km/h +0.5 MJ, 8.5 MJ/lap recovery, 768 kg): https://www.formula1.com/en/latest/article/explained-2026-power-unit-regulations-fia.68izKQ2tn1voQPWvgLVMXN , https://www.mclaren.com/racing/formula-1/2026/explaining-f1s-new-2026-regulations/ , https://www.espn.com/racing/f1/story/_/id/48090668/2026-f1-rules-whats-new-cars-how-changes-affect-racing
- Assets: https://quaternius.com/packs/cars.html (CC0), https://kenney.nl/assets/car-kit (CC0), Sketchfab CC-BY low-poly F1 models: https://sketchfab.com/3d-models/low-poly-f1-0ac02bfa81f64549be15acaa78f36f29 , https://sketchfab.com/3d-models/basic-lowpoly-f1-car-v1-b4c6a1cfe0154f4d86b39ff3b7f955a1 , https://sketchfab.com/3d-models/low-poly-f1-60cc881988e64a429aad8a1b6ef4d307
