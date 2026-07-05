/**
 * Track-agnostic energy-deployment optimizer + evidence analysis.
 *
 * The physics question — "where on the lap should I deploy the MGU-K, and where
 * should I harvest, to minimise lap time under a fixed energy budget?" — is a
 * constrained optimal-control problem. Pontryagin's minimum principle says the
 * optimal deploy is *bang-bang*: full power wherever the marginal time saved per
 * Joule exceeds a threshold (the energy co-state), off elsewhere. The threshold
 * is whatever balances the energy budget.
 *
 * We solve it at the granularity the player actually controls — the ~N deploy
 * zones — by coordinate ascent over the real lap simulation: repeatedly try each
 * discrete level in each zone and keep whatever lowers a penalised lap-time
 * objective (lap time + a stiff penalty for exceeding the net-energy budget).
 * Seeded from a sensible heuristic this converges to a strong optimum in a few
 * sweeps. Because it only reads `track.zones` and the shared lap sim, it works
 * on ANY track built by the pipeline — Silverstone today, whatever CSV is added
 * tomorrow — with zero track-specific code.
 *
 * `zoneValueAnalysis` is the teaching companion: for each zone it measures, from
 * a no-deploy baseline, how much lap time deploying *only there* would save (the
 * "value" heat-map) and how much lifting there would cost. That is the evidence
 * an amateur learns from — it shows, per track, where energy buys time and where
 * it is wasted.
 *
 * Everything here is a pure, deterministic function of (track, options): no rng,
 * no DOM, no three.js — so the UI can run it in a Web Worker.
 */
import type { DeployMap, TrackData } from './types';
import { PU } from './constants';
import { projectLap, simulateLaps } from './projection';

export interface OptimizeOptions {
  /** measured racing laps per evaluation (energy balance is enforced by the
   *  no-refill multi-lap sim, so no artificial budget is needed) */
  raceLaps?: number;
  /** candidate deploy levels per zone (bang-bang [0,1] is theoretically optimal;
   *  intermediate levels approximate deploying over part of a zone). */
  deployLevels?: number[];
  liftLevels?: number[];
  /** coordinate-ascent sweeps over all zones */
  maxSweeps?: number;
  /** starting map (defaults to the built-in heuristic) */
  seedMap?: DeployMap;
  /** progress callback in [0,1] for the Web Worker UI */
  onProgress?: (fraction: number) => void;
}

export interface OptimizeResult {
  map: DeployMap;
  /** best sustainable race-lap time (mean of the measured racing laps), s */
  lapTime: number;
  /** deployed / harvested on the final measured lap, MJ */
  deployedMJ: number;
  harvestedMJ: number;
  /** flying-lap time of the winning map (matches the strategy screen's number) */
  flyingLapTime: number;
  /** lap-sim evaluations spent (for telemetry) */
  evaluations: number;
}

export interface ZoneValue {
  zoneId: number;
  name: string;
  /** lap time saved by deploying ONLY in this zone vs nowhere, s (>0 = valuable) */
  deployValueSec: number;
  /** lap time COST of full lift/harvest in this zone, s (low = cheap to harvest here) */
  harvestCostSec: number;
  /** normalised 0..1 deploy value across the lap, for heat-map colouring */
  valueNorm: number;
}

export interface ZoneValueAnalysis {
  baselineLapTime: number;
  zones: ZoneValue[];
  /** the single most valuable zone to deploy in */
  bestZoneId: number;
}

const DEFAULT_DEPLOY_LEVELS = [0, 0.5, 1];
const DEFAULT_LIFT_LEVELS = [0, 0.5, 1];

function clone(m: DeployMap): DeployMap {
  return { zoneDeploy: [...m.zoneDeploy], zoneLift: [...m.zoneLift] };
}

function zerosMap(track: TrackData): DeployMap {
  return { zoneDeploy: track.zones.map(() => 0), zoneLift: track.zones.map(() => 0) };
}

/**
 * Heuristic seed: deploy on the acceleration/straight zones (where energy buys
 * speed on the way to the next braking point), harvest through the grip-limited
 * corner zones. Purely structural — no track-name knowledge.
 */
export function heuristicMap(track: TrackData): DeployMap {
  return {
    zoneDeploy: track.zones.map((z) => (z.accelZone || z.kind === 'straight' ? 1 : 0)),
    zoneLift: track.zones.map((z) => (!z.accelZone && z.kind !== 'straight' ? 0.5 : 0)),
  };
}

interface Eval {
  score: number; // mean sustainable racing-lap time, s (lower = better)
  deployedMJ: number;
  harvestedMJ: number;
}

/**
 * Objective = mean sustainable racing-lap time. The no-refill multi-lap sim
 * makes over-deployment self-defeating (the battery empties and later laps slow
 * to ICE pace), so the fastest map is the one that deploys in the highest-value
 * places up to what it can recover — exactly the lesson we want to teach.
 */
function evaluate(track: TrackData, map: DeployMap, raceLaps: number): Eval {
  const r = simulateLaps(track, map, 1, raceLaps);
  const laps = r.racingLapTimes;
  const score = laps.length === raceLaps ? r.totalRaceTime / raceLaps : 1e6;
  const last = laps.length - 1;
  return {
    score,
    deployedMJ: last >= 0 ? r.deployedMJ[last] : 0,
    harvestedMJ: last >= 0 ? r.harvestedMJ[last] : 0,
  };
}

export function optimizeDeployMap(track: TrackData, opts: OptimizeOptions = {}): OptimizeResult {
  const raceLaps = opts.raceLaps ?? 3;
  const deployLevels = opts.deployLevels ?? DEFAULT_DEPLOY_LEVELS;
  const liftLevels = opts.liftLevels ?? DEFAULT_LIFT_LEVELS;
  const maxSweeps = opts.maxSweeps ?? 3;

  let map = clone(opts.seedMap ?? heuristicMap(track));
  let best = evaluate(track, map, raceLaps);
  let evaluations = 1;

  // exclusive (deploy, lift) candidates: deploy>0 XOR lift>0 (or both 0)
  const candidates: Array<[number, number]> = [];
  for (const d of deployLevels) candidates.push([d, 0]);
  for (const l of liftLevels) if (l > 0) candidates.push([0, l]);

  const nZones = track.zones.length;
  const totalWork = maxSweeps * nZones;
  let workDone = 0;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let improved = false;
    for (let z = 0; z < nZones; z++) {
      let localBest = best;
      let localMap = map;
      for (const [d, l] of candidates) {
        if (map.zoneDeploy[z] === d && map.zoneLift[z] === l) continue; // current
        const trial = clone(map);
        trial.zoneDeploy[z] = d;
        trial.zoneLift[z] = l;
        const e = evaluate(track, trial, raceLaps);
        evaluations++;
        if (e.score < localBest.score - 1e-4) {
          localBest = e;
          localMap = trial;
        }
      }
      if (localMap !== map) {
        map = localMap;
        best = localBest;
        improved = true;
      }
      workDone++;
      opts.onProgress?.(workDone / totalWork);
    }
    if (!improved) break;
  }

  opts.onProgress?.(1);
  return {
    map,
    lapTime: best.score,
    deployedMJ: best.deployedMJ,
    harvestedMJ: best.harvestedMJ,
    flyingLapTime: projectLap(track, map, false).lapTime,
    evaluations,
  };
}

/**
 * Per-zone deploy value + harvest cost, measured from a no-energy baseline —
 * the evidence layer. For each zone: lap time if you deployed ONLY there (full)
 * vs deploying nowhere gives its intrinsic value; lap time lifting only there
 * gives its harvest cost. Independent of the current map, so it colours the
 * track by "where is energy worth spending" for THIS circuit.
 */
export function zoneValueAnalysis(track: TrackData, opts: { fast?: boolean } = {}): ZoneValueAnalysis {
  const fast = opts.fast ?? false; // accuracy matters for the teaching heat-map
  const base = zerosMap(track);
  const baselineLapTime = projectLap(track, base, fast).lapTime;

  const zones: ZoneValue[] = track.zones.map((zone) => {
    const dMap = clone(base);
    dMap.zoneDeploy[zone.id] = 1;
    const deployLap = projectLap(track, dMap, fast).lapTime;

    const lMap = clone(base);
    lMap.zoneLift[zone.id] = 1;
    const liftLap = projectLap(track, lMap, fast).lapTime;

    return {
      zoneId: zone.id,
      name: zone.name,
      deployValueSec: baselineLapTime - deployLap,
      harvestCostSec: liftLap - baselineLapTime,
      valueNorm: 0, // filled below
    };
  });

  const maxValue = Math.max(1e-6, ...zones.map((z) => z.deployValueSec));
  for (const z of zones) z.valueNorm = Math.max(0, z.deployValueSec) / maxValue;

  let bestZoneId = 0;
  let bestVal = -Infinity;
  for (const z of zones) if (z.deployValueSec > bestVal) { bestVal = z.deployValueSec; bestZoneId = z.zoneId; }

  return { baselineLapTime, zones, bestZoneId };
}

/** Convenience: net energy drain of a map over a lap, MJ (>0 = unsustainable). */
export function netDrainMJ(track: TrackData, map: DeployMap): number {
  const p = projectLap(track, map, true);
  return p.deployedMJ - p.harvestedMJ;
}

export { PU as OPTIMIZER_PU };
