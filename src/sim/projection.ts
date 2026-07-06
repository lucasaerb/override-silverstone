/**
 * Headless lap projection: run the real physics forward for a solo car on a
 * given deployment map and report what that strategy produces — projected lap
 * time, energy deployed/harvested, top speed, and the State-of-Charge trace
 * around the lap. This powers the strategy screen's live "what does this map
 * do?" feedback: the sim runs ~3,700x realtime, so a projection is a few tens
 * of ms and can be recomputed on every (debounced) map edit.
 *
 * It is NOT the race — no rival, no override, no standing-start rule. It is a
 * flying quali lap from a full battery, which is the honest question a player
 * asks while painting a map: "if I run this on a clear lap, where does my
 * energy go and how fast am I?".
 *
 * Determinism: no rng, pure function of (track, map). The racing line and
 * speed limit depend only on the track, so they are cached per TrackData.
 */
import type { CarState, DeployMap, TrackData } from './types';
import { PU, SIM } from './constants';
import { computeVLimit, stepCar } from './physics';
import { computeRacingLine, type RacingLine } from './racingLine';

export interface LapProjection {
  /** projected flying-lap time, s; NaN if the car could not complete a lap */
  lapTime: number;
  deployedMJ: number;
  harvestedMJ: number;
  topSpeedKmh: number;
  /** SoC fraction (0..1) sampled per track sample around the measured lap */
  socSeries: Float32Array;
  /** deploy power (W) per track sample — for the projection graph */
  powerSeries: Float32Array;
  /** speed (km/h) per track sample around the measured lap */
  speedSeries: Float32Array;
}

interface TrackKinematics {
  line: RacingLine;
  vLimit: Float32Array;
}

const cache = new WeakMap<TrackData, TrackKinematics>();

/** Racing line + speed limit for a track, computed once and reused. */
export function trackKinematics(track: TrackData): TrackKinematics {
  let k = cache.get(track);
  if (!k) {
    const line = computeRacingLine(track);
    k = { line, vLimit: computeVLimit(track, line.kappa) };
    cache.set(track, k);
  }
  return k;
}

function makeCar(map: DeployMap): CarState {
  return {
    id: 'player',
    s: 0,
    lap: 0,
    v: 80, // rolling start near flying speed so the warm-up lap settles fast
    lateralOffset: 0,
    energy: {
      soc: PU.ES_WINDOW,
      harvestedThisLap: 0,
      deployedThisLap: 0,
      overrideArmed: false,
      overrideActive: false,
      overrideBonusRemaining: 0,
      lastDeployPowerW: 0,
    },
    deployMap: map,
    inputs: { boostHeld: false, aggressiveness: 1 },
    aeroMode: 'Z',
    inTow: false,
    gear: 8,
    throttle: 1,
    brake: 0,
    deployPowerW: 0,
    totalTime: 0,
    currentLapTime: 0,
    lapTimes: [],
    currentSectors: [],
    bestLap: null,
    finished: false,
    finishTime: null,
  };
}

/**
 * Project a flying lap for `map`. Runs one warm-up lap (to settle the speed
 * profile and the energy cycle), refills the battery to full, then measures
 * the next lap.
 *
 * `fast` skips the warm-up and measures the very first lap directly (car seeded
 * near flying speed with a full battery). It is ~2x cheaper and, crucially,
 * consistent across maps — so the optimizer's hundreds of relative comparisons
 * use it, while the UI uses the accurate warm-up path for the numbers it shows.
 */
export function projectLap(track: TrackData, map: DeployMap, fast = false): LapProjection {
  const { vLimit } = trackKinematics(track);
  const n = track.samples.length;
  const car = makeCar(map);
  const ctx = { session: 'quali' as const, otherCar: null, raceTime: 0 };

  const socSeries = new Float32Array(n).fill(NaN);
  const powerSeries = new Float32Array(n).fill(NaN);
  const speedSeries = new Float32Array(n).fill(NaN);
  const maxTicks = Math.round((8 * 120) / SIM.DT); // ~8 laps of headroom
  // fast mode measures the first full lap (car already starts at s=0, full SoC)
  let measuring = fast;
  let deployedMJ = 0;
  let harvestedMJ = 0;
  let topSpeedKmh = 0;
  let lapTime = NaN;

  for (let t = 0; t < maxTicks; t++) {
    const beforeLaps = car.lapTimes.length;
    stepCar(car, track, vLimit, ctx, SIM.DT);
    const crossed = car.lapTimes.length > beforeLaps;

    if (crossed) {
      if (!measuring) {
        // end of the warm-up lap: refill and start measuring the next lap
        car.energy.soc = PU.ES_WINDOW;
        measuring = true;
      } else {
        lapTime = car.lapTimes[car.lapTimes.length - 1];
        break;
      }
    } else if (measuring) {
      const i = Math.min(n - 1, Math.floor(car.s / track.ds));
      const kmh = car.v * 3.6;
      socSeries[i] = car.energy.soc / PU.ES_WINDOW;
      powerSeries[i] = car.deployPowerW;
      speedSeries[i] = kmh;
      deployedMJ = car.energy.deployedThisLap / 1e6;
      harvestedMJ = car.energy.harvestedThisLap / 1e6;
      if (kmh > topSpeedKmh) topSpeedKmh = kmh;
    }
  }

  forwardFill(socSeries);
  forwardFill(powerSeries);
  forwardFill(speedSeries);
  return { lapTime, deployedMJ, harvestedMJ, topSpeedKmh, socSeries, powerSeries, speedSeries };
}

export interface MultiLapResult {
  /** completed racing-lap times (after the settle lap), s */
  racingLapTimes: number[];
  /** total time over the racing laps — what wins a race, s */
  totalRaceTime: number;
  /** deployed / harvested per racing lap, MJ */
  deployedMJ: number[];
  harvestedMJ: number[];
  /** lowest battery fraction reached (0..1) — <~0.05 means it ran dry */
  minSocFrac: number;
}

/**
 * Multi-lap race simulation from a full battery, NO refill between laps — so
 * the energy balance is physical: a map that deploys more than it harvests
 * drains the battery over the opening laps and its later laps fall to ICE-only
 * pace. Runs `settleLaps` warm-up laps then `raceLaps` measured laps. This is
 * the objective the optimizer minimises (sustainable race pace), and it needs
 * no artificial energy-budget constraint — the sim enforces it.
 */
export function simulateLaps(
  track: TrackData,
  map: DeployMap,
  settleLaps = 1,
  raceLaps = 4,
): MultiLapResult {
  const { vLimit } = trackKinematics(track);
  const car = makeCar(map);
  const ctx = { session: 'race' as const, otherCar: null, raceTime: 0 };
  const wanted = settleLaps + raceLaps;
  const maxTicks = Math.round(((wanted + 3) * 120) / SIM.DT);

  const racingLapTimes: number[] = [];
  const deployedMJ: number[] = [];
  const harvestedMJ: number[] = [];
  let minSocFrac = 1;
  let completed = 0;

  for (let t = 0; t < maxTicks && completed < wanted; t++) {
    const before = car.lapTimes.length;
    const dBefore = car.energy.deployedThisLap;
    const hBefore = car.energy.harvestedThisLap;
    stepCar(car, track, vLimit, ctx, SIM.DT);
    const soc = car.energy.soc / PU.ES_WINDOW;
    if (soc < minSocFrac) minSocFrac = soc;
    if (car.lapTimes.length > before) {
      completed++;
      if (completed > settleLaps) {
        racingLapTimes.push(car.lapTimes[car.lapTimes.length - 1]);
        deployedMJ.push(dBefore / 1e6);
        harvestedMJ.push(hBefore / 1e6);
      }
    }
  }

  const totalRaceTime = racingLapTimes.length === raceLaps
    ? racingLapTimes.reduce((s, x) => s + x, 0)
    : 1e6; // never completed → unusable
  return { racingLapTimes, totalRaceTime, deployedMJ, harvestedMJ, minSocFrac };
}

/** Fill NaN gaps (samples the car stepped over) with the previous value; wraps. */
function forwardFill(a: Float32Array): void {
  const n = a.length;
  let last = 0;
  for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) { last = a[i]; break; }
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(a[i])) a[i] = last;
    else last = a[i];
  }
}

/** Expose the racing line for render code that wants the projection's cache. */
export function racingLineFor(track: TrackData): RacingLine {
  return trackKinematics(track).line;
}
