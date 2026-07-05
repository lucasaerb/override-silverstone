# Silverstone Circuit — F1 Simulation Research Dossier

**Layout:** Grand Prix circuit, 5.891 km, 18 turns, clockwise. Race distance 52 laps / 306.198 km.
**Compiled:** 2026-07-04 (2026 British GP weekend — Sprint/Quali complete, race on 2026-07-05).

**Legend:** `[S]` = sourced value, `[E]` = estimated (physics/telemetry-informed engineering estimate), `[C]` = computed from TUMFTM centerline data in `track-data/`.

---

## 1. Corner-by-corner table (modern F1 car, qualifying trim, 2024–25 era)

Distances are measured along the centerline from the current start/finish line (Hamilton Straight) `[C]` — apex = max-curvature point of the TUMFTM centerline; accuracy roughly ±20 m. Speeds are for a 2024/25-era car in qualifying; 2026 cars are ~3–4 s/lap slower (see section 4).

| # | Corner | Dir | Apex dist (m) [C] | Entry speed (km/h) | Apex/min speed (km/h) | Gear | Braking zone | Flat in quali? |
|---|--------|-----|------------------|--------------------|----------------------|------|--------------|----------------|
| T1 | Abbey | R | 395 | ~300 [E] | 285–295 [E] | 8 [E] | None — lift/brush of brake only [S] | Virtually (slight lift) [S] |
| T2 | Farm Curve | L | 645 | ~290 [E] | 280–290 [E] | 8 [E] | None [S] | Yes [S] |
| T3 | Village | R | 894 | 295 [S] | ~125–130 [S] | 3 [E] | 115 m, 2.33 s, 4.5g peak, 152 kg pedal [S — Brembo; hardest stop rated by Brembo] | No |
| T4 | The Loop | L | 1,044 | ~130 [E] | 95–105 [E] — slowest corner on the lap [S] | 2 [E] | ~25–35 m light trail-brake [E] | No |
| T5 | Aintree | L | ~1,230 | ~230 [E] | 245–260 accelerating [E] | 6–7 [E] | None [S] | Yes [S] |
| — | **Wellington Straight** | — | 1,294→1,889 low-curvature [C] | — | End-of-straight ~310–323 [S: 323 recorded at Brooklands entry] | 8 | — | — |
| T6 | Brooklands | L | 2,004 | 323 [S] | ~150–160 [S: 152 quoted; 5.4g decel] | 4 [E] | ~110–125 m [E] | No |
| T7 | Luffield | R | 2,179 | ~180 [E] | 130–145 [E] (long double-apex right) | 3–4 [E] | Carried from T6, short reapplication [E] | No |
| T8 | Woodcote | R | ~2,500 | ~230 building [E] | 260–280 through exit [E] | 7–8 [E] | None [E] | Yes / tiny lift [E] |
| — | **National (old pit) straight** | — | 2,628→3,008 [C] | — | End ~305–315 [E] | 8 | — | — |
| T9 | Copse | R | 3,133 | ~315 [E] | 290–305 [S: taken flat >300 km/h by pole-sitters in recent seasons] | 8 [E] | None in quali (small lift in race trim) [S] | Yes [S] |
| T10 | Maggotts | L | 3,613 | ~300 [S] | 285–295 [S: complex approached at ~300, >5g lateral] | 8 [E] | None | Yes [S] |
| T11 | Becketts 1 | R | 3,713 | ~290 [E] | 255–270 [E] | 7 [E] | Lift only [S: "speed bleeds off gradually"] | No (lift) |
| T12 | Becketts 2 | L | 3,888 | ~260 [E] | 230–245 [E] | 6–7 [E] | Lift/brush [E] | No (lift) |
| T13 | Becketts 3 | R | 4,018 | ~235 [E] | 200–215 [E] | 6 [E] | Short brush of brakes [E] | No |
| T14 | Chapel | L | 4,193 | ~210 [E] | 225–240 accelerating [S: throttle back down through Chapel] | 6→7 [E] | None | Yes from apex |
| — | **Hangar Straight** (875 m [S]) | — | 4,228→4,953 low-curvature, slight R kink at 4,778 [C] | — | Top speed of lap: ~320–330, up to ~340 with tow/DRS-era [E/S] | 8 | — | — |
| T15 | Stowe | R | 5,083 | ~320–330 [E] | 245–260 [E] (medium-to-high-speed right [S]) | 6–7 [E] | ~60–80 m light [E] | No (but minimal braking) |
| T16 | Vale | L | 5,517 | >300 [S] | ~110–125 [E] | 3 [E] | Hardest braking event: >300→194 km/h in ~71 m at 5.5g [S], total zone ~110–130 m to apex [E]; downhill and bumpy [S] | No |
| T17 | Club (apex 1) | R | 5,597 | ~130 [E] | 150–165 [E] | 4–5 [E] | None (accelerating) | No |
| T18 | Club (exit) | R | ~5,720 | — | 190–220 building, flat from second apex [S: "flat in most cars"] | 6→8 [E] | None | Yes from apex |
| — | **Hamilton (pit) straight** | — | 5,807→375 (wrap through S/F at 5,887/0) [C] | — | ~290–300 crossing the line [E] | 8 | — | — |

Corner numbering T1–T18 verified [S — total-motorsport.com corner guide]: T1 Abbey, T2 Farm, T3 Village, T4 The Loop, T5 Aintree, T6 Brooklands, T7 Luffield, T8 Woodcote, T9 Copse, T10–T14 Maggotts/Becketts/Chapel, T15 Stowe, T16 Vale, T17–T18 Club. The Wellington Straight sits between T5 and T6 (it is not itself a numbered turn).

### Straights and top speeds
- **Hangar Straight** (Chapel→Stowe): 875 m [S, widely cited]; ~725 m of near-zero curvature on the centerline [C]. **Highest top speed of the lap occurs at its end, braking for Stowe** — ~320–330 km/h quali, ~340 km/h with slipstream [E]. Speed-trap location.
- **Wellington Straight** (Aintree→Brooklands): 770 m [S, widely cited]; ~595 m near-zero curvature [C]. End speed up to 323 km/h recorded at Brooklands entry [S].
- **Hamilton/International Pit Straight** (Club→Abbey): ~770 m effective [S/E]; ~455 m near-zero curvature between Club exit and Abbey turn-in [C]. ~290–300 km/h at the line [E].
- **National straight** (old pit straight, Woodcote→Copse): ~380 m near-zero curvature [C], ~500–600 m effective [E]. ~305–315 km/h into Copse [E].

### Lap-level numbers
- **Full throttle:** 65% of the lap (race trim) [S — Haas F1]; ~70–78% in qualifying where Abbey/Copse go flat [E].
- **Braking:** 8 braking events/lap, 11 s total on brakes, Brembo difficulty 1/5 (3 hard stops — Village, Brooklands, Vale; 1 medium; 4 light) [S — Brembo].
- **Race lap record:** 1:27.097 — Max Verstappen, 2020 — average speed 243.494 km/h [S — F1.com].
- **Pole laps:** 2024 Russell 1:25.819 (avg ~247 km/h) [S]; 2025 Verstappen 1:24.892 (avg ~250 km/h, >155 mph) [S]; **2026 Antonelli 1:28.111 (avg ~240.7 km/h)** [S].
- **Race pace:** dry-race laps typically 1:29–1:33 (fuel/tyre dependent); 2025 race fastest lap 1:29.337 (Piastri, mixed conditions) [S]. Average race speed ~225 km/h [S — Haas F1].

---

## 2. Track geometry data (files saved)

Saved under `/Users/lucaserb/Documents/f1_project/research/track-data/`:

### `silverstone_tumftm.csv` — PRIMARY for sim (has widths)
- Source: TUMFTM/racetrack-database (TU Munich), `tracks/Silverstone.csv`.
- Raw URL: `https://raw.githubusercontent.com/TUMFTM/racetrack-database/master/tracks/Silverstone.csv`
- Format: CSV, header `# x_m,y_m,w_tr_right_m,w_tr_left_m`.
- **1,178 points**, local Cartesian meters (arbitrary origin at first point), ~5 m spacing, closed loop.
- **Measured centerline length: 5,886.8 m** [C] — vs 5,891 m official (0.07% error, excellent).
- **Track widths included**: `w_tr_right_m` + `w_tr_left_m` per point. Total width min 11.3 m / max 17.8 m / mean 13.8 m [C] — consistent with the commonly quoted ~15 m typical width (TUMFTM widths are conservative racing-surface bounds).
- Start of dataset = **current start/finish line** — confirmed by shape-matching corner positions (Village at 894 m, Brooklands at 2,004 m, Stowe at 5,083 m, all consistent with the S/F on the Hamilton Straight) [C].
- Derived from real telemetry/aerial data by TUM (used in their minimum-curvature raceline papers).

### `silverstone_f1circuits.geojson` — georeferenced backup
- Source: bacinger/f1-circuits, `circuits/gb-1948.geojson`.
- Raw URL: `https://raw.githubusercontent.com/bacinger/f1-circuits/master/circuits/gb-1948.geojson`
- Format: GeoJSON FeatureCollection, one LineString.
- **135 points**, WGS84 `[lon, lat]` (EPSG:4326). First point (-1.015349, 52.07879) is on the National straight (the repo's start point is NOT the current S/F line — re-reference before use).
- Properties: `id: gb-1948, length: 5891, altitude: 196` (m ASL).
- No width data; coarser than TUMFTM (44 m avg spacing). Use for georeferencing/minimap; use TUMFTM for physics.
- To convert to meters: local equirectangular about lat 52.078 — `x = R·cos(lat₀)·Δlon`, `y = R·Δlat` (R = 6,371,000 m).

### `silverstone_corners_derived.csv` — derived corner index [C]
- My curvature analysis of the TUMFTM centerline: per turn — segment start/end, apex distance from S/F, minimum **centerline** radius, direction. Note the racing-line radius is typically 1.5–3x the centerline minimum (e.g., Abbey centerline r≈40 m but is driven at ~290 km/h on a ~130–150 m line radius using the full 15 m width).

Key centerline radii [C]: The Loop 17 m (tightest), Vale 23 m, Village 25 m, Club 30 m, Abbey 40 m, Brooklands 41 m, Luffield 44 m, Becketts-1 57 m, Copse/Aintree 60 m, Becketts-3 68 m, Stowe 72 m, Woodcote 78 m, Becketts-2 89 m, Farm 102 m, Maggotts 157 m.

---

## 3. Overtaking, slipstream, and 2026 energy context

### Passing spots (in order of importance)
1. **Into Brooklands (T6)** — end of Wellington Straight (770 m). The prime move: slipstream out of Aintree, brake from ~323 to ~152 km/h. Was DRS zone #2 in the 2011–2025 era.
2. **Into Stowe (T15)** — end of Hangar Straight (875 m). Highest closing speeds of the lap; wide entry allows outside and inside lines.
3. **Into Village (T3)** — first heavy braking zone [S]; run through flat-out Abbey/Farm plus the pit-straight tow (was DRS zone #1 on the Hamilton Straight) sets up lunges here.
4. **Into Vale (T16)** — hardest braking of the lap (5.5g, ~71 m from >300 km/h) [S]; classic late-lunge spot after a failed Stowe attempt; compromises Club exit.
5. **Into Copse (T9)** — rare, brave, around-the-outside or after a National-straight tow (e.g., Hamilton/Verstappen 2021).

Straights that matter for slipstream/deployment: Wellington and Hangar are the passing straights [S — Haas: "passing chances on the Wellington and Hangar straights"]; the Hamilton pit straight mainly sets up T3.

### 2026 regulations at Silverstone (from the 2026 British GP weekend, reported this week) [S]
- **Straight Mode (X-mode, low-drag) zones — 4 total:** start/finish straight; T5→T6 (Wellington); T7→T9 (Luffield exit through Woodcote to Copse, the National straight); T14→T15 (Hangar) [S — F1.com circuit guide].
- **Overtake Mode / Manual Override (DRS replacement):** detection point after the T17 exit, activation before T18 onto the start/finish straight [S — F1.com]; boost then usable down the Hamilton Straight into Abbey/Village.
- **Energy management:** FIA capped deployment at **8 MJ race / 6.5 MJ qualifying** (0.5 MJ below Barcelona) to mitigate "super-clipping" [S — motorsport.com]. Silverstone dubbed a "charging station" track: drivers clip (part-lift) through T1–T2 to save charge for Wellington; Brooklands braking is a key harvesting point; Maggotts/Becketts is the designated "sacrificial" recharge zone — cars corner visibly slower there than 2025 to harvest before Hangar [S].
- **Racing effect:** "yo-yo racing" expected — a driver who deploys on one straight is vulnerable on the next [S].
- **2026 car speeds vs 2025:** Copse still largely flat >300 km/h in quali; Maggotts/Becketts and Stowe notably slower (downforce + energy harvesting). Pole slowed from 1:24.892 (2025) to 1:28.111 (2026) [S].
- **2026 weekend results so far:** Sprint pole Hamilton (Ferrari); Sprint win Antonelli (Mercedes) ahead of Hamilton (+2.745 s, pass for lead on lap 8 — an Overtake-Mode-era pass) and Norris; GP pole Antonelli 1:28.111 ahead of Leclerc (+0.175), Hamilton, Russell, Hadjar, Norris [S]. GP runs 2026-07-05.

### Elevation
- Near-flat WWII airfield: **~11 m total elevation change** over the lap [S]; circuit sits at ~196 m ASL [S — GeoJSON metadata].
- Notable micro-features: **downhill, bumpy braking into Vale** [S]; gentle crest/fall through the Farm–Village section and a slight rise through Stowe exit [E]. For the sim, a flat track with a small dip into Vale is a defensible approximation.

### Track width
- ~15 m typical [S, commonly quoted]; TUMFTM per-point data: 11.3–17.8 m, mean 13.8 m [C]. Widest zones: Stowe entry and the Club/Vale complex; narrowest: Becketts mid-section [C].

---

## 4. Timing sectors (3)

Official FIA sector-boundary distances are not published; boundaries below are taken from the broadcast/official track map positions, distances read off the TUMFTM centerline [E/C]:

| Sector | Boundary | Approx distance from S/F | Contents |
|--------|----------|--------------------------|----------|
| S1 | S/F line → mid-Wellington Straight (before Brooklands braking) | 0 → ~1,780 m [E] | Abbey, Farm, Village, The Loop, Aintree, most of Wellington |
| S2 | → Hangar Straight just before Stowe braking | ~1,780 → ~4,900 m [E] | Brooklands, Luffield, Woodcote, Copse, Maggotts/Becketts/Chapel, most of Hangar |
| S3 | → S/F line | ~4,900 → 5,891 m [E] | Stowe, Vale, Club, Hamilton Straight |

Indicative quali sector splits (2024-era, from a ~1:25.8 pole): S1 ~28.5 s, S2 ~34.5 s, S3 ~22.8 s [E].

---

## 5. Sources
- F1.com 2026 Silverstone circuit guide (length, 18 turns, laps, lap record 1:27.097 / 243.494 km/h, 2026 Straight Mode zones, Overtake Mode points)
- Brembo F1 brake facts UK GP (8 braking events, 11 s/lap, T3: 295→130 km/h, 115 m, 2.33 s, 4.5g, 152 kg)
- f1chronicle.com Silverstone track guide (Brooklands 323→152 km/h 5.4g; Vale >300→194 km/h in 71 m, 5.5g; Copse ~290 "fastest corner"; Abbey ~280 flat)
- driver61.com Silverstone GP circuit guide (corner character, flat/lift classification)
- motorsport.com "How charging-station Silverstone will really look different in F1 2026" (8/6.5 MJ caps, harvesting zones, yo-yo racing, Copse flat >300)
- Haas F1 "Pedal to the Metal at Silverstone" (65% full throttle, ~225 km/h average, Wellington/Hangar passing)
- F1.com / Sky Sports / RacingNews365 2026 British GP weekend reports (Antonelli pole 1:28.111, Sprint results)
- Wikipedia 2025 British Grand Prix (Norris win, Piastri FL 1:29.337, Verstappen pole 1:24.892)
- total-motorsport.com Silverstone corner names (T1–T18 numbering)
- TUMFTM/racetrack-database and bacinger/f1-circuits (geometry, this repo's track-data/)
