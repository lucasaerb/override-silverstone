# 2026 F1 Power Unit & Energy Deployment — Research Findings for Simulation

**Compiled:** 4 July 2026 (British GP weekend — season is ~11 rounds in)
**Primary sources:** FIA 2026 F1 Technical Regulations Section C, Issue 12 (10 June 2025) — read directly from the official PDF; FIA 2026 F1 Sporting Regulations Section B, Issue 05 (27 Feb 2026) — read directly from the official PDF; plus 2026-season reporting (The Race, Motorsport.com, Autosport, ESPN, AMuS, Honda, Raceteq, PlanetF1, f1chronicle, motorsport-total, scuderiafans, thejudge13).

**Confidence key:**
- **CONFIRMED** — exact text read from the FIA regulation PDFs (article numbers cited)
- **REPORTED** — from 2026-season journalism (reputable outlet(s); multiple where possible)
- **ESTIMATED** — my own computation/inference; reasoning stated

---

## SIMULATION CONSTANTS

### A. Power unit architecture

| Constant | Value | Source | Confidence |
|---|---|---|---|
| ICE configuration | 1.6 L (1600cc +0/−10cc) V6 90°, single turbo, no MGU-H | FIA C5.1.2–C5.1.3, C5.3.1 | CONFIRMED |
| ICE peak power | ~400 kW (536 hp); AMuS says 400–430 kW | The Race, Motorsport.com, AMuS | REPORTED |
| Fuel energy flow cap (full load) | 3000 MJ/h | FIA C5.2.3 | CONFIRMED |
| Fuel energy flow below 10,500 rpm | EF(MJ/h) = 0.27 × N(rpm) + 165 | FIA C5.2.4 | CONFIRMED |
| Fuel energy flow at partial load | EF = 380 MJ/h if engine power ≤ −50 kW; EF = 9.78 × P(kW) + 869 if P > −50 kW | FIA C5.2.5 (anti fuel-burn-to-harvest rule) | CONFIRMED |
| Implied ICE thermal efficiency | ~48% (400 kW ÷ 833 kW fuel power) | derived from C5.2.3 + reported 400 kW | ESTIMATED |
| MGU-K max electrical DC power (deploy AND recover) | 350 kW ("absolute" power) | FIA C5.2.7 | CONFIRMED |
| MGU-K max torque | 500 Nm at crankshaft speed | FIA C5.2.11 | CONFIRMED |
| Electrical↔mechanical conversion efficiency (regulatory) | 0.97 fixed correction | FIA C5.2.21 | CONFIRMED |
| Combined peak power | ~750 kW (~1005–1015 hp) | 400 ICE + 350 K; widely reported | REPORTED |
| ICE-only power when battery empty | ~400 kW (car loses ~47% of peak) | derived | ESTIMATED (solid) |
| Race fuel load | ~70 kg (down from ~100 kg) | f1chronicle, formula1.com explainers | REPORTED |
| Engine intake pressure cap | 4.8 barA | FIA C5.3.2 | CONFIRMED |
| Turbo speed cap | 150,000 rpm | FIA C5.3.6 | CONFIRMED |
| Min PU mass / min ES enclosure mass / min MGU-K mass | 185 kg / 35 kg / 16–20 kg | FIA C5.5.2, C5.17.9, C5.18.7 | CONFIRMED |
| Engine modes | ONE ICE mode per competitive lap (no quali modes) — all tactics are electrical | FIA C5.23 "Single ICE Mode" | CONFIRMED |

### B. Energy store & recovery

| Constant | Value | Source | Confidence |
|---|---|---|---|
| ES usable window (max−min state of charge) | 4 MJ at any time on track | FIA C5.2.9 | CONFIRMED |
| Max Recharge (energy harvested by ERS-K, measured at CU-K HV DC bus) per lap | 8.5 MJ baseline | FIA C5.2.10 | CONFIRMED |
| Circuit-specific Recharge reduction | to 8 MJ where FIA determines max possible braking+partial-load harvest ≤ 8 MJ | FIA C5.2.10.i | CONFIRMED |
| Qualifying-session Recharge reduction | reducible further, floor of 5 MJ, for SQ/Qualifying at events where harvesting tactics deemed excessive | FIA C5.2.10.ii | CONFIRMED |
| Number of events allowed the quali reduction | max 8 per championship (Issue 05); expanded to 12 in the Miami package | FIA B7.2.1.c; ESPN/Honda (Apr 2026) | CONFIRMED (8) / REPORTED (12) |
| Extra Recharge with Overtake mode | +0.5 MJ on any race lap where Overtake was enabled & activated as the driver crossed the Line at lap start | FIA C5.2.10.iii + B7.2.1.b.v | CONFIRMED |
| Recovery power under braking | up to 350 kW (same absolute limit as deployment; no separate lower recovery cap) | FIA C5.2.7 | CONFIRMED |
| Full 4 MJ window recharge time at 350 kW | ~11.4 s | derived; PlanetF1 quotes "~11 s" | CONFIRMED (math) |
| Non-ERS energy stores on car | ≤ 300 kJ total; ≤ 20 kJ/lap recovered at > 2 kW | FIA C5.2.18 | CONFIRMED |
| MGU-K use at race start | only above 50 km/h on a standing start | FIA C5.2.12 | CONFIRMED |
| ES charging in garage during quali | ≤ 100 kJ increase while stationary | FIA C5.2.13 | CONFIRMED |
| Realistic braking-only harvest, low-braking circuit (Albert Park) | 3–4 MJ/lap vs 8 MJ cap (drivers spend ~11% of lap braking vs 17.1% F1 average) | PlanetF1 data piece | REPORTED |

### C. Deployment power vs speed — THE TAPER (normal mode)

FIA C5.2.8.i (Issue 12, June 2025 — the version the 2026 season started under). ERS-K power used to propel the car may not exceed:

| Car speed v (km/h) | Max MGU-K deploy power | Formula | Confidence |
|---|---|---|---|
| ≤ 290 | 350 kW (full) | P capped by C5.2.7; formula crosses 350 at v=290 | CONFIRMED |
| 290 → 340 | 350 → 100 kW, slope **−5 kW per km/h** | P(kW) = 1800 − 5v | CONFIRMED |
| 340 → 345 | 100 → 0 kW, slope **−20 kW per km/h** | P(kW) = 6900 − 20v | CONFIRMED |
| ≥ 345 | 0 kW | — | CONFIRMED |

Sample points for a lookup table: 290→350, 300→300, 310→250, 320→200, 330→150, 340→100, 342.5→50, 345→0.

**Source-conflict note:** many secondary outlets (formula1.com explainer, Motorsport.com, f1chronicle) state normal-mode taper "begins at 290, zero at 355 km/h", and one quotes "P = 1850 − 5v". That matches an **earlier draft** (2024 PU regs, Issue 7/8 era). The final published Issue 12 text I read directly is 1800 − 5v with zero at **345** km/h. Use the Issue 12 numbers; keep 355 as the *override* zero-point (below).

**Per-circuit modification (CONFIRMED mechanism, B7.2.1.b.i–ii):** the FIA may adjust the power-vs-speed curves per circuit "for the sole purpose of ensuring the maximum speed of the F1 Car remains compatible with the… circuit", published ≥4 weeks before each event. REPORTED examples (AMuS, pre-season FIA data leak): Monaco and Singapore run a reduced-power curve in both normal and Override modes (without it, ~350 km/h out of Monaco's tunnel vs ~290 today).

### D. Overtake mode (née "Manual Override Mode") — the DRS replacement

| Constant | Value | Source | Confidence |
|---|---|---|---|
| Override power curve | P(kW) = 7100 − 20v below 355 km/h; P = 0 at ≥ 355 km/h | FIA C5.2.8.ii | CONFIRMED |
| Full 350 kW held until | **337.5 km/h** (7100 − 20v = 350), then −20 kW per km/h to zero at 355 | FIA C5.2.8.ii (math) | CONFIRMED |
| Advantage vs normal mode | identical ≤290 km/h; grows with speed; at 340 km/h: 300 vs 100 kW; at 345: 200 vs 0 kW; 337.5–355 band is where the attacker has power and the defender has ~none | derived from C5.2.8 | CONFIRMED (math) |
| Eligibility gap ("Detection Gap") | value set per event by FIA; universally reported as **1.0 s** behind any other car | FIA B7.2.1.b.vii (mechanism); Motorsport.com, Sky, ESPN (1s value) | CONFIRMED (mechanism) / REPORTED (1.0 s) |
| Detection | at a single **Detection Line** per circuit (position set by FIA, marked by solid yellow line + signage) — NOT continuous, NOT multiple DRS-style zones | FIA B7.2.1.b.viii, B7.2.1.f | CONFIRMED |
| Activation window | from the **Activation Line**: if the car was < Detection Gap behind another car at the Detection Line, Overtake is activated at the Activation Line and remains usable until the next Activation Line crossing (i.e., ~a full lap), where it deactivates if the gap was > Detection Gap at the last Detection Line | FIA B7.2.3.c | CONFIRMED |
| Races: enabling | Disabled at race start until the leader first crosses the Detection Line; disabled under Safety Car (re-enabled after all cars cross the Line once the SC enters the pits); Race Director may disable/re-enable at any time | FIA B7.2.2.b–d | CONFIRMED |
| Qualifying / practice | Overtake is **enabled from the start and activated at all times** — any driver may freely use the override power curve (this is why quali top speeds reach ~355 km/h) | FIA B7.2.2.a, B7.2.3.b | CONFIRMED |
| Extra energy | +0.5 MJ additional Recharge allowance on that lap (≈1.4 s of extra 350 kW) — an extra *harvest* budget, popularly described as "0.5 MJ of extra energy" | FIA C5.2.10.iii; formula1.com | CONFIRMED |
| Defending car | NO restriction on the car ahead — it just lives with the normal taper (zero deploy ≥345 km/h) while the attacker keeps power to 355 | FIA B7.2 (no such clause exists) | CONFIRMED (by absence) |
| Per-lap / per-race usage cap | none in the regs beyond energy itself; dash shows "override activations remaining within the energy budget" (energy-limited, not count-limited) | B7.2; f1chronicle | CONFIRMED / REPORTED |
| Driver action | Overtake is armed automatically by the FIA ECU but **used/selected by the driver** (button); C5.12.5 allows the power-demand increase mid-straight only "when the overtake mode… is selected by the driver" | FIA C5.12.5, B7.2.3.a | CONFIRMED |
| Failure mode | team may ask Race Director for permission to operate detection manually | FIA B7.2.4 | CONFIRMED |
| **Mid-season change (Miami, May 2026):** race Boost/Override power step capped at **+150 kW above the deployment level at activation** (or the level at activation if higher) to kill dangerous closing speeds | Honda F1-explained, ESPN, Motorsport.com | REPORTED |

**Note on session terminology:** the Sporting Regs split sessions into "LTCS" (qualifying-type — Overtake always on) and "TTCS" (race-type — gap-conditional Overtake, Safety Car clauses, "leader" language). The acronym expansions weren't in the pages read, but the mechanics above are unambiguous from the article text. One secondary source (f1chronicle) claims the override cuts out mid-zone if the gap exceeds 1s "continuously monitored" — the actual reg text only re-evaluates at Activation Line crossings; trust the reg.

### E. Deployment shaping / "clipping" rules (how the power comes OFF)

| Constant | Value | Source | Confidence |
|---|---|---|---|
| Max ramp-down rate of driver max power demand | **50 kW per 1 s** at events with power-limited distance > 3500 m; **100 kW per 1 s** at all others | FIA C5.12.6.a–b | CONFIRMED |
| 50 kW/s circuits (2026) | Melbourne, Jeddah, Silverstone, Spa, Monza, Baku, Las Vegas | AMuS (FIA circuit data) | REPORTED |
| Max total in-straight power reduction | 450 kW, and ERS-K power must stay above **−100 kW** (race); relaxed to **600 kW / −250 kW** in SQ/Qualifying | FIA C5.12.6 | CONFIRMED |
| "Super clipping" (harvest at full throttle) | ERS-K goes negative while flat-out; originally limited to 250 kW recharge; raised to **350 kW** (quali + race) from Miami to shorten superclip phases from ~6–10 s to ~2–4 s per lap | FIA C5.12.6 framework; Motorsport.com/Honda (change) | REPORTED (numbers), CONFIRMED (mechanism) |
| Step-down at throttle application | driver max power demand cannot drop > 150 kW at the start of a full-throttle period; reduction then fixed ≥ 1 s | FIA C5.12.4 | CONFIRMED |
| No mid-straight power increase | power demand may not increase during a full-throttle period **except** driver-selected Overtake | FIA C5.12.5 | CONFIRMED |
| Ramp-rate exceptions (free power cuts) | below 210 km/h; during gearshifts; negative driver demand; etc. | FIA C5.12.7 | CONFIRMED |
| **Miami package zone rule:** 350 kW deploy only in "key acceleration zones" (corner exit → braking point, incl. overtaking zones); **250 kW cap elsewhere** in the lap (races) | Speedcafe, ESPN, Honda, Motorsport.com | REPORTED |

### F. Per-lap energy budgets & durations (the numbers the game loop needs)

| Quantity | Value | Basis | Confidence |
|---|---|---|---|
| Battery window emptied at full deploy | 4 MJ ÷ 350 kW = **11.4 s** | C5.2.9 + C5.2.7 | CONFIRMED (math) |
| Steady-state deployable energy per race lap | ≈ the lap Recharge cap: **8.5 MJ** baseline; **8.0 MJ** typical 2026 race value; ≈ **24.3 s / 22.9 s** of full-power equivalent | C5.2.10; event docs | CONFIRMED / REPORTED |
| One-lap max deploy (burning down the SoC window) | Recharge cap + 4 MJ window ≈ **12–12.5 MJ** one-off | derived | ESTIMATED |
| Overtake bonus | 0.5 MJ ≈ **1.4 s** extra full power | C5.2.10.iii | CONFIRMED (math) |
| 2026 season Recharge values used so far | Melbourne: quali 7.0 / race 8.0 (+0.5 w/ Overtake) / FP 8.5 MJ. Suzuka: cut to 8 MJ. Post-Miami default: quali 7.0. **Silverstone (this weekend): quali 6.5 (was 7.5), sprint & race 8.0 MJ** | Autosport (Melbourne), The Race (Suzuka), Motorsport.com (Silverstone) | REPORTED |
| Pre-season FIA per-circuit table (superseded in places) | Standard category (~12 circuits: Suzuka, Miami, Spa, Madrid, Austin…): race 8.5, +override 9.0. Barcelona/Silverstone/Zandvoort: 8.5. Jeddah: FP 8.5 / quali 6.5 / race 8.0. Monza: quali 6.0. Monaco & Singapore: reduced power curves ("Rev1") | AMuS FIA-data piece | REPORTED |
| Lap time cost of 1 MJ less quali recharge | ~1 s/lap (7 MJ vs 8 MJ); ~2 s at 6 MJ | The Race (FIA estimates, Apr 2026) | REPORTED |
| 2026 vs 2025 pace | Melbourne FP2: 2026 benchmark ~3 s/lap slower than 2025 | PlanetF1 | REPORTED |
| End-of-straight "energy cliff" | speed collapse of **~50–55 km/h** on one straight when deployment ends/harvest begins (Antonelli, Australia: 325 → 270 km/h before braking, still at full throttle) | scuderiafans telemetry analysis | REPORTED |
| Power swing across one lap | 750 kW → 400 kW → as low as ~200 kW (ICE 400 minus ~200 kW superclip harvest, pre-Miami figures) | technology.org, The Race | REPORTED |

### G. Percentage-based deployment & driver controls (game-design mapping)

| Item | What's real | Source | Confidence |
|---|---|---|---|
| Deployment maps | Teams pre-program map sets in the FIA Standard ECU governing "the aggression of MGU-K deployment through specific parts of a circuit" and SoC targets vs the 4 MJ window; drivers select maps from steering-wheel rotaries and are told to switch lap-by-lap by radio | f1chronicle, formula1.com key-terms | REPORTED |
| Boost button | Driver-pressable at **any point on any lap**: triggers either full power or "a profile configured by the team as per their personal choice" — i.e., discretionary spend-anywhere deployment | formula1.com key-terms explainer | REPORTED |
| Recharge maps | Harvest under braking / part throttle / superclip is **automated** by selectable Recharge maps + targets; the one recharge mode under direct driver control is **lift-off regeneration** (lifting throttle harvests; also drops Active Aero out of straight mode) | formula1.com, GPFans | REPORTED |
| SOC display | Dash shows state of charge and remaining override capability; race engineers coach SoC targets per lap | f1chronicle | REPORTED |
| Discrete % levels per zone | **Not publicly documented.** No regulation defines percentage steps; per-zone deploy % is team-side ECU calibration. Wheels historically carry ~8–12-position SOC/deploy rotaries; 2026 wheels reported to have an expanded mode range. A game model of "set deploy % per track segment + SoC target" is a faithful abstraction of what team software actually does; exact step counts are team-secret | inference from f1chronicle/PMW + historical precedent | ESTIMATED |
| Harvest tricks drivers actively do | early lift-and-coast into corners; downshifting to lower gears than racing-optimal (even 1st) to spin the K for recovery; running high rpm in corners in "generation mode" (burning fuel to charge, constrained by the C5.2.5 partial-load fuel curve); compromising fast corners (Maggotts/Becketts) to harvest | Motorsport-total (Williams' Harman/Tsiaparas), The Race Silverstone | REPORTED |

---

## 1. Power unit architecture (detail)

The 2026 PU keeps a 1.6L V6 turbo but deletes the MGU-H entirely (C5.2.1 permits only the engine and the "ERS-K" to propel/harvest). Fuel is 100% sustainable, regulated by **energy** flow (3000 MJ/h) rather than mass flow — the SECU converts measured fuel mass flow to energy flow using FIA-measured LHV (C5.2.6). ICE output is not directly capped but falls out of the fuel-flow cap at roughly 400 kW (~48% efficiency). MGU-K grows 120→350 kW, giving a near 50:50 split (55:45 by kW). The partial-load fuel-flow curve (C5.2.5) exists specifically to limit "burning fuel to charge the battery" while off-throttle — but generation mode within the curve is legal and used.

There is **one ICE mode per competitive lap** (C5.23). Everything tactical in 2026 is on the electrical side, which is why energy deployment dominates race craft.

## 2. Recovery

Only the MGU-K recovers (braking, part throttle, lift-off, superclip). The 8.5 MJ/lap Recharge cap is measured at the CU-K HV DC bus (C5.2.10). Without the MGU-H, harvest supply is circuit-dependent: Albert Park's two real braking zones yield only 3–4 MJ/lap from braking alone, so teams top up with lift-and-coast, downshift harvesting, and superclipping — the behaviors drivers called "annoying" and "sad" (Bearman) in testing and that the FIA has been legislating against all season.

## 3. Deployment rules (detail and season evolution)

**Baseline (Issue 12):** full 350 kW to 290 km/h; −5 kW/km/h to 100 kW at 340; −20 kW/km/h to zero at 345. Override: 350 kW to 337.5 km/h, −20 kW/km/h to zero at 355. FIA can and does adjust curves per circuit for top-speed safety (Monaco, Singapore reduced).

**Mid-season changes (all REPORTED, effective dates per reporting):**
- **Melbourne (R1, March):** qualifying Recharge cut 8.5→7.0 MJ to stop extreme lift-and-coast harvesting on flying laps (using C5.2.10.ii). Session split at that event: race 8.0 (8.5 with Overtake), FP 8.5.
- **Suzuka (R3):** general recharge trimmed to 8 MJ.
- **April 9 crunch meeting** (after Bearman's high-closing-speed crash in Japan): six-fix package drafted.
- **Miami (May 1–3) package, WMSC e-vote, unanimous:** quali recharge 8→7 MJ standing (further cuts allowed at 12 events, up from 8); superclip recharge power 250→350 kW (halves superclip duration to ~2–4 s/lap); race deployment restricted to 350 kW in key acceleration zones (corner exit→braking point) and 250 kW elsewhere; race Boost/Override step capped at +150 kW over the level at activation; automatic MGU-K anti-stall deployment + flashing lights for slow starts; reduced ERS deployment in wet running.
- **Silverstone (R? — this weekend):** quali recharge trimmed again 7.5→6.5 MJ; sprint/race 8.0 MJ.

## 4. Overtake mode in practice

It is energy, not aero, so it works in dirty air; but it is also **not free** — it draws from the same battery, so a driver who defended hard last lap may not be able to fund an attack this lap. Racing has been reshaped:
- Melbourne produced **120 overtakes vs 45 in 2025** — but The Race's analysis flags "yo-yo racing": passes made on deployment are frequently undone a lap later because the passer overspent (Russell–Leclerc, Melbourne, repeated position swaps at unusual corners). Russell had predicted exactly this: passes "in obscure locations… if a driver's at the bottom of their battery and the one behind has more."
- Overtaking is physically easier (smaller, lighter cars) and passes happen away from traditional zones; critics say craft has shifted from apex speed to "energy regime optimization", and gaps between cars have grown even as passes increased.
- Safety issue: pre-Miami, a following car could arrive with a ~350 kW power delta at the moment the leader's deployment tapered/ramped down — implicated in Bearman's Japan crash; hence the +150 kW activation step cap and the 250 kW non-acceleration-zone cap.
- Exploits reported (thejudge13, blog — treat as low-medium confidence): Mercedes triggering emergency MGU-K shutdown to skip the mandated 50 kW/s ramp-down (60 s lockout traded away on cooldown laps, Japan quali); Antonelli micro-lifting before the line so negative power demand never starts the ramp-down (Silverstone SQ — where he took P2 to Hamilton's pole, per Sky/F1.com).

## 5. Is the game's "fixed per-lap budget, spend it anywhere" model true?

**Yes, at first order — with four correction terms.** The per-lap deployable budget in a steady-state race lap ≈ the event's Recharge cap (8.0–8.5 MJ race; 6.5–7 MJ quali), plus/minus up to 4 MJ of SoC window carried between laps. Drivers/teams genuinely choose where it goes (Boost button anywhere, team-configured profiles, deployment maps per circuit segment), and energy spent attacking on one straight is provably unavailable on the next (documented "yo-yo" repassing). Corrections for fidelity:
1. **Speed taper** — deploy power is speed-capped (Section C table); you physically cannot spend faster than 350 kW, and above 290 km/h the pipe narrows to zero at 345 (355 in Override).
2. **Zone caps (post-Miami races)** — 350 kW only corner-exit→braking-point; 250 kW elsewhere.
3. **Ramp-down shaping** — power must come off at ≤50/100 kW/s (no instant cliff, but the resulting "clipping" still costs ~50 km/h by the end of long straights), can't step down >150 kW at throttle application, can't come back up mid-straight except via Overtake.
4. **Recovery is place-dependent** — refilling the budget requires braking zones, lifting, or superclipping at real lap-time cost; on low-braking circuits the budget effectively shrinks (Albert Park 3–4 MJ from brakes vs 8 MJ cap).

## 6. Silverstone snapshot (4 July 2026 — live season color)

Silverstone is rated the season's hardest energy track ("charging station" — Motorsport.com): ~70%+ full throttle, few heavy stops, so Maggotts/Becketts is driven compromised in corner-mode to harvest for Hangar Straight; cars clip through T1–T2 to bank for the Wellington straight; quali recharge trimmed to 6.5 MJ, race 8.0; 50 kW/s ramp circuit. Hamilton ("battery power will be poor"), Alonso ("not fun… quite sad"), Verstappen (sim "felt like a different track") all pre-criticized it; Hamilton took sprint pole from Antonelli and Verstappen. Pundits fear peak "yo-yo racing" in the GP because deployment spent defending one straight leaves you a sitting duck on the next.

## 7. Numbers to prefer when sources conflict

| Topic | Conflicting values | Recommendation |
|---|---|---|
| Normal-mode taper zero point | 345 km/h (FIA Issue 12) vs 355 km/h (many outlets, older draft) | **345**; use 355 only for Override |
| Taper formula | 1800 − 5v (FIA Issue 12) vs 1850 − 5v (one outlet) | **1800 − 5v** |
| Override full-power threshold | 337.5 km/h (FIA formula) vs "337" (media rounding) | **337.5** |
| Recharge/lap baseline | 8.5 MJ (FIA) vs "9 MJ" (GPFans, The Race "quali max 9") | **8.5**; 9.0 = 8.5 + 0.5 Overtake bonus |
| Superclip recharge power | 200 kW (technology.org) vs 250 kW pre-Miami / 350 kW post-Miami (Motorsport, Honda, ESPN) | **250 → 350 kW**, Miami boundary |
| ES capacity | window is regulated (4 MJ delta SoC), not gross capacity; media "battery holds 4 MJ / 1.1 kWh" | model **4 MJ usable window**; gross cell capacity is larger but irrelevant to sim |

## 8. Suggested sim implementation notes (ESTIMATED — my synthesis)

- State: `SoC ∈ [0, 4] MJ`, `lap_recharge_used ∈ [0, cap]`, `overtake_armed` (bool, evaluated once per lap at Detection Line vs 1.0 s gap), `overtake_bonus_available` (0.5 MJ).
- Deploy power = min(350, taper(v, override?), zone_cap(segment), player_deploy_%(segment) × 350) with ramp-down slew of 50 kW/s when budget exhausts (never instant), and a +150 kW step cap on Override activation in races.
- Recharge power = min(350, brake_harvest(v, decel), superclip if flat-out, lift_regen if lifting) until `lap_recharge_used` hits the event cap; lap counter resets at the timing line (C5.2.2: pit entry ends the lap at pit-lane start).
- Expect optimal AI laps to deploy full on corner exits up to ~290 km/h, harvest at straight-ends (superclip) and in braking, and hold ~0.5–1 MJ reserve for defense — matching observed 2026 driving.

## Key sources

- FIA 2026 F1 Technical Regulations, Section C, Issue 12 (10 Jun 2025): https://api.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_c_technical_-_iss_12_-_2025-06-10.pdf (Articles C5.1–C5.23, esp. C5.2.3–C5.2.21, C5.12, C5.23)
- FIA 2026 F1 Sporting Regulations, Section B, Issue 05 (27 Feb 2026): https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_b_sporting_-_iss_05_-_2026-02-27.pdf (Article B7.2 Energy Deployment Limitations)
- formula1.com 2026 PU regulations explainer & key-terms explainer; McLaren/Sky/ESPN 2026 explainers
- The Race: "F1's plan for six 2026 rules fixes" (Apr 2026); Australia overtaking analysis; Silverstone preview
- Motorsport.com: FIA confirms Miami changes (Apr 2026); "charging station Silverstone" (Jul 2026); terminology explainer; Bearman/Ocon testing complaints
- Autosport: Melbourne qualifying recharge cut (Mar 2026)
- Honda global F1-explained: Miami regulation changes (numbers)
- auto motor und sport: FIA per-circuit power data ("Zwei Strecken zu gefährlich")
- ESPN: 2026 rule tweaks explained (Apr 2026); Hamilton Silverstone battery comments
- PlanetF1: Albert Park battery recovery data; scuderiafans: superclipping telemetry (Antonelli 325→270 km/h), Melbourne 120-overtake analysis
- motorsport-total.com: battery-charging tricks (Williams quotes); PMW Magazine: F1 2026 tech hub
- thejudge13 (blog, lower confidence): Mercedes ramp-down exploits (Jul 2026)
