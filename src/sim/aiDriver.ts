/**
 * The AI rival: hand-tuned 2026 deployment maps for the 19 real Silverstone
 * zones plus the per-tick behavior controller (updateAi).
 *
 * Map philosophy (research/2026-energy-regs.md §5-6, research/silverstone.md
 * §overtaking): Silverstone is a "charging station" track — the meta is to
 * harvest where the car is grip-limited (superclip through Maggotts/Becketts,
 * lift-and-coast into the heavy brake zones) and spend where energy buys the
 * most lap time (corner exits and the Wellington/Hangar/National straights,
 * where passes actually happen).
 *
 * Zone ids (track.ts ZONE_SPECS order):
 *   0 Pit Straight    1 Abbey–Farm      2 Village Brake  3 The Loop
 *   4 Aintree Exit    5 Wellington      6 Brooklands     7 Luffield
 *   8 Woodcote        9 National       10 Copse         11 Maggotts
 *  12 Becketts       13 Chapel Exit    14 Hangar        15 Stowe
 *  16 Vale Brake     17 Club           18 Club Exit
 *
 * Determinism: the ONLY rng consumption is one aggressiveness-jitter draw per
 * lap per car. Everything else is a pure function of the race state, so a
 * given seed replays tick-exactly.
 */
import type { CarState, DeployMap, TrackData } from './types';
import { PU, SIM } from './constants';
import { timeGapSeconds } from './physics';
import type { Rng } from './rng';

// ---------------------------------------------------------------- maps

export const AI_MAPS: Record<'balanced' | 'aggressive' | 'defensive', DeployMap> = {
  /**
   * The 2026 meta map ("charging station" Silverstone): full deploy on the
   * passing straights (Pit/Wellington/Hangar) + the exits feeding them; zero
   * deploy (= superclip harvest at full throttle) through Copse and
   * Maggotts/Becketts — the designated sacrificial recharge zone — and the
   * twisty Village/Loop/Luffield section; heavy lift-and-coast into the
   * brake zones to fill the lap's 8 MJ harvest allowance every lap.
   * Deliberately harvest-rich: the AI banks pace it can spend reacting
   * (defensive/aggressive swaps) when the racing gets close.
   */
  balanced: {
    //           Pit  A-F  Vil  Loop Ain  Wel  Bro  Luf  Woo  Nat  Cop  Mag  Bec  Cha  Han  Sto  Val  Clu  CEx
    zoneDeploy: [1, 0.25, 0, 0, 0.75, 1, 0, 0, 0.5, 0.75, 0, 0, 0, 0.75, 1, 0, 0, 0.25, 0.75],
    zoneLift: [0, 0.5, 0.75, 0.75, 0, 0, 0.75, 0.5, 0, 0, 0, 0.75, 0.75, 0, 0, 0.75, 0.75, 0, 0],
  },
  /**
   * More deploy, less harvest: full send in every zone (much of it
   * traction-wasted in the slow corners), no lifting, no superclip zones —
   * so the per-lap cycle is braking regen only. Very quick in a burst while
   * the initial charge lasts, but the SoC floors within two laps and the
   * lean 2.3 MJ/lap cycle that remains is no faster than balanced.
   */
  aggressive: {
    zoneDeploy: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    zoneLift: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  /**
   * Defend the braking zones: full deploy is kept on the straights themselves
   * (Pit/Wellington/Hangar/National) while the corner exits are trimmed — at
   * zone granularity that is what "deploy weighted to the END of straights"
   * means: the budget is not burned on exits, so the straight-zone deploy
   * does not clip early and the car is still at full power where the attack
   * lands. Token 0.25 deploy in the twisty zones keeps the corner exits
   * alive (no superclip stalls mid-defence); light lifts rebuild some of
   * what defending costs.
   */
  defensive: {
    zoneDeploy: [1, 0.25, 0.25, 0.25, 0.5, 1, 0, 0.25, 0.5, 1, 0.25, 0.25, 0.25, 0.5, 1, 0.25, 0.25, 0.5, 1],
    zoneLift: [0, 0, 0.25, 0.25, 0, 0, 0.5, 0.25, 0, 0, 0, 0.25, 0.25, 0, 0, 0.25, 0.25, 0, 0],
  },
};

/** Deep-copies a map so live swaps never share mutable arrays between cars. */
export function cloneDeployMap(map: DeployMap): DeployMap {
  return { zoneDeploy: [...map.zoneDeploy], zoneLift: [...map.zoneLift] };
}

// ---------------------------------------------------------------- behavior

/** don't burn override charge below this SoC, J */
const BOOST_MIN_SOC_J = 0.8e6;
/** map-swap trigger: rival reacts when the player is within this gap, s */
const CLOSE_GAP_S = 1.2;
/** end-of-race aggression kicks in within this gap during the final 2 laps */
const FINAL_LAPS_GAP_S = 1.5;
const FINAL_LAPS_AGGRESSION = 0.1;
/** below this fraction of ES_WINDOW the AI backs off to rebuild charge */
const LOW_SOC_FRAC = 0.15;
const LOW_SOC_AGGRESSION = 0.15;
/** once-per-lap aggressiveness noise, ± */
const JITTER = 0.02;
/** CarInputs.aggressiveness contract bounds */
const AGGRESSIVENESS_MIN = 0.5;
const AGGRESSIVENESS_MAX = 1.25;

/**
 * True inside one of the four active-aero straight-mode spans — the only
 * places the AI will hold boost (an armed override spent mid-corner is
 * wasted: the car is grip-limited there, not power-limited).
 */
export function isBoostZone(track: TrackData, s: number): boolean {
  for (const z of track.straightModeZones) {
    if (z.sStart <= z.sEnd ? s >= z.sStart && s < z.sEnd : s >= z.sStart || s < z.sEnd) {
      return true;
    }
  }
  return false;
}

interface AiMem {
  /** the map the car started the race on — the "else" of the live swap */
  neutral: DeployMap;
  /** per-car clones of AI_MAPS so parallel sims never share mutable maps */
  aggressive: DeployMap;
  defensive: DeployMap;
  jitter: number;
  jitterLap: number;
}

/** Sub-lap AI bookkeeping lives outside the CarState contract (cf. override.ts). */
const mem = new WeakMap<CarState, AiMem>();

/**
 * Per-tick AI driver. Called by RaceController for the rival:
 *  - boostHeld: only when override is armed, the car is on a straight-mode
 *    span and there is enough charge to make the boost count;
 *  - live map swap: attacked (other car behind within 1.2 s) -> defensive;
 *    attacking (other car ahead within 1.2 s) -> aggressive; else back to the
 *    neutral (start-of-race) map — AI_MAPS[rivalSkill] by default;
 *  - aggressiveness: base 1.0 ± a once-per-lap 0.02 jitter (the only rng use),
 *    +0.1 when the fight is within 1.5 s in the final 2 laps, −0.15 when the
 *    battery is under 15% and needs rebuilding.
 *
 * `lapsTotal` is an optional extension of the documented signature (defaults
 * to the v1 race distance) so "final 2 laps" tracks the configured race.
 */
export function updateAi(
  car: CarState,
  otherCar: CarState,
  track: TrackData,
  rng: Rng,
  _raceTime: number,
  lapsTotal: number = SIM.RACE_LAPS,
): void {
  let m = mem.get(car);
  if (!m) {
    m = {
      neutral: car.deployMap,
      aggressive: cloneDeployMap(AI_MAPS.aggressive),
      defensive: cloneDeployMap(AI_MAPS.defensive),
      jitter: 0,
      jitterLap: -1,
    };
    mem.set(car, m);
  }
  if (m.jitterLap !== car.lap) {
    m.jitter = rng.range(-JITTER, JITTER);
    m.jitterLap = car.lap;
  }

  // -- live map swap (race order decided by total progress, not raw s)
  const myProgress = car.lap * track.length + car.s;
  const otherProgress = otherCar.lap * track.length + otherCar.s;
  const iAmAhead = myProgress >= otherProgress;
  const gapBehind = timeGapSeconds(otherCar, car, track); // other chasing me
  const gapAhead = timeGapSeconds(car, otherCar, track); // me chasing other
  if (iAmAhead && gapBehind < CLOSE_GAP_S) car.deployMap = m.defensive;
  else if (!iAmAhead && gapAhead < CLOSE_GAP_S) car.deployMap = m.aggressive;
  else car.deployMap = m.neutral;

  // -- aggressiveness
  let aggressiveness = 1 + m.jitter;
  const fightGap = iAmAhead ? gapBehind : gapAhead;
  if (car.lap >= lapsTotal - 1 && fightGap <= FINAL_LAPS_GAP_S) {
    aggressiveness += FINAL_LAPS_AGGRESSION;
  }
  if (car.energy.soc < LOW_SOC_FRAC * PU.ES_WINDOW) {
    aggressiveness -= LOW_SOC_AGGRESSION;
  }
  car.inputs.aggressiveness = Math.min(
    AGGRESSIVENESS_MAX,
    Math.max(AGGRESSIVENESS_MIN, aggressiveness),
  );

  // -- boost: never waste an armed override in the corners
  car.inputs.boostHeld =
    car.energy.overrideArmed && car.energy.soc > BOOST_MIN_SOC_J && isBoostZone(track, car.s);
}
