import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { CALIBRATION, PU, SIM } from '../src/sim/constants';
import { computeVLimit, stepCar, type StepCtx } from '../src/sim/physics';
import { computeRacingLine } from '../src/sim/racingLine';
import { buildTrack, parseTrackCsv } from '../src/sim/track';
import type { CarState } from '../src/sim/types';
import { makeCar } from './synthetic';

/**
 * End-to-end calibration against the real 2026 Silverstone reference points
 * (research/silverstone.md): pole 1:28.111, race pace 89-95 s, 315-345 km/h
 * end of Hangar, the energy-depletion cliff, and per-corner apex speeds.
 * The lap runners here are test helpers, not production code.
 */
const DT = SIM.DT;
const csv = readFileSync('public/data/silverstone.csv', 'utf8');
const track = buildTrack(parseTrackCsv(csv), 'Silverstone');
const line = computeRacingLine(track);
const vLimit = computeVLimit(track, line.kappa);

const ctx = (session: 'race' | 'quali'): StepCtx => ({ session, otherCar: null, raceTime: 0 });

interface QualiResult {
  lapTimes: number[];
  sectors: number[];
  /** corner name -> speed crossing Corner.apexS on the flying lap, km/h */
  apexKmh: Map<string, number>;
  /** full end-of-run car state, for determinism comparison */
  finalState: string;
}

/**
 * Quali runner: full battery, deploy map all-1.0, two laps from a standing
 * start; lap 1 doubles as the out-lap and the ES is recharged to full as the
 * car takes the line (garage charge + out-lap harvesting premise), so lap 2
 * is the representative flying lap.
 */
function runQualiFlyingLap(): QualiResult {
  const car = makeCar('player', track);
  const c = ctx('quali');
  const watched = track.corners.filter((k) => k.name in CALIBRATION.APEX_TARGETS_KMH);
  const apexKmh = new Map<string, number>();
  let sectors: number[] = [];
  while (car.lapTimes.length < 2) {
    const prevS = car.s;
    const prevLaps = car.lapTimes.length;
    stepCar(car, track, vLimit, c, DT);
    if (prevLaps === 0 && car.lapTimes.length === 1) car.energy.soc = PU.ES_WINDOW;
    if (prevLaps === 1) {
      for (const k of watched) {
        if (prevS < k.apexS && car.s >= k.apexS) apexKmh.set(k.name, car.v * 3.6);
      }
      if (car.lapTimes.length === 2) sectors = [...car.currentSectors];
    }
  }
  return { lapTimes: [...car.lapTimes], sectors, apexKmh, finalState: JSON.stringify(car) };
}

let qualiMemo: QualiResult | null = null;
const quali = (): QualiResult => (qualiMemo ??= runQualiFlyingLap());

/** Race runner: standing start, deploy all-1.0, `laps` laps; returns per-lap
 * time and the deployed/harvested totals captured just before each rollover. */
function runRace(laps: number): Array<{ t: number; deployed: number; harvested: number }> {
  const car = makeCar('player', track);
  const c = ctx('race');
  const perLap: Array<{ t: number; deployed: number; harvested: number }> = [];
  while (car.lapTimes.length < laps) {
    const deployed = car.energy.deployedThisLap;
    const harvested = car.energy.harvestedThisLap;
    const prevLaps = car.lapTimes.length;
    stepCar(car, track, vLimit, c, DT);
    if (car.lapTimes.length > prevLaps) {
      perLap.push({ t: car.lapTimes[car.lapTimes.length - 1], deployed, harvested });
    }
  }
  return perLap;
}

/** speed at CALIBRATION.HANGAR_END_S and the Hangar-span max, on lap 2 */
function hangarProbe(prepare: (car: CarState) => void, pinDepleted: boolean) {
  const car = makeCar('player', track);
  prepare(car);
  const c = ctx('quali');
  let spanMax = 0;
  let vEnd = 0;
  while (car.lapTimes.length < 2) {
    const prevS = car.s;
    if (pinDepleted) {
      // empty ES and zero harvest headroom (base cap consumed, no override bonus)
      car.energy.soc = 0;
      car.energy.harvestedThisLap = PU.HARVEST_CAP_QUALI;
      car.energy.overrideBonusRemaining = 0;
    }
    stepCar(car, track, vLimit, c, DT);
    if (car.lapTimes.length === 1) {
      if (car.s >= CALIBRATION.HANGAR_SPAN_START_S && car.s < CALIBRATION.HANGAR_SPAN_END_S) {
        spanMax = Math.max(spanMax, car.v * 3.6);
      }
      if (prevS < CALIBRATION.HANGAR_END_S && car.s >= CALIBRATION.HANGAR_END_S) {
        vEnd = car.v * 3.6;
      }
    }
  }
  return { spanMax, vEnd };
}

/** 2026 "save it for Hangar" strategy: deploy only onto/along the Hangar
 * Straight, superclip-harvest everywhere else so the ES is full at Chapel. */
function hangarDeployMap(car: CarState): void {
  car.deployMap.zoneDeploy = track.zones.map((z) =>
    z.name === 'Chapel Exit' || z.name === 'Hangar Straight' ? 1 : 0,
  );
}

describe('quali calibration', () => {
  it(`flying lap lands on the 2026 pole: ${CALIBRATION.QUALI_LAP_TARGET} +/- ${CALIBRATION.QUALI_LAP_TOLERANCE} s`, () => {
    const lap = quali().lapTimes[1];
    expect(lap).toBeGreaterThan(CALIBRATION.QUALI_LAP_TARGET - CALIBRATION.QUALI_LAP_TOLERANCE);
    expect(lap).toBeLessThan(CALIBRATION.QUALI_LAP_TARGET + CALIBRATION.QUALI_LAP_TOLERANCE);
  });

  it('flying lap has three sectors summing to the lap time', () => {
    const { lapTimes, sectors } = quali();
    expect(sectors).toHaveLength(3);
    expect(sectors[0] + sectors[1] + sectors[2]).toBeCloseTo(lapTimes[1], 6);
  });

  it('apex speeds match the research targets', () => {
    const { apexKmh } = quali();
    for (const [name, target] of Object.entries(CALIBRATION.APEX_TARGETS_KMH)) {
      const got = apexKmh.get(name);
      expect(got, `missing apex crossing for ${name}`).toBeDefined();
      const residual = CALIBRATION.APEX_RESIDUAL_KMH[name] ?? 0;
      expect(got!, `${name} apex`).toBeGreaterThan(
        target - CALIBRATION.APEX_TOLERANCE_KMH - residual,
      );
      expect(got!, `${name} apex`).toBeLessThan(target + CALIBRATION.APEX_TOLERANCE_KMH);
    }
  });
});

describe('race calibration', () => {
  const perLap = runRace(5);
  const steady = perLap.slice(1); // 4 consecutive laps after the warm-up lap

  it(`steady-state race pace sits in [${CALIBRATION.RACE_LAP_MIN}, ${CALIBRATION.RACE_LAP_MAX}] s`, () => {
    expect(steady).toHaveLength(4);
    const mean = steady.reduce((a, l) => a + l.t, 0) / steady.length;
    expect(mean).toBeGreaterThanOrEqual(CALIBRATION.RACE_LAP_MIN);
    expect(mean).toBeLessThanOrEqual(CALIBRATION.RACE_LAP_MAX);
  });

  it('the per-lap energy budget bites: deploy is harvest-limited under the cap', () => {
    // energy captured one tick before rollover; allow one tick of slop
    const tickSlop = PU.K_POWER * DT;
    for (const lap of perLap) {
      expect(lap.deployed).toBeLessThanOrEqual(PU.HARVEST_CAP_RACE + PU.ES_WINDOW + tickSlop);
    }
    for (const lap of steady) {
      // steady state: everything deployed came from this lap's harvest
      expect(lap.deployed).toBeLessThanOrEqual(PU.HARVEST_CAP_RACE + tickSlop);
      expect(Math.abs(lap.deployed - lap.harvested)).toBeLessThan(0.2e6);
      expect(lap.deployed).toBeGreaterThan(1e6); // regen actually running
    }
  });
});

describe('top speed and the depletion cliff', () => {
  const deploying = hangarProbe(hangarDeployMap, false);
  const depleted = hangarProbe(() => {}, true);

  it(`Hangar-zone top speed in [${CALIBRATION.TOP_SPEED_MIN_KMH}, ${CALIBRATION.TOP_SPEED_MAX_KMH}] km/h in quali trim`, () => {
    expect(deploying.spanMax).toBeGreaterThan(CALIBRATION.TOP_SPEED_MIN_KMH);
    expect(deploying.spanMax).toBeLessThan(CALIBRATION.TOP_SPEED_MAX_KMH);
  });

  it(`an empty-ES car with no harvest headroom loses >= ${CALIBRATION.DEPLETION_DELTA_MIN_KMH} km/h by the end of Hangar`, () => {
    expect(deploying.vEnd).toBeGreaterThan(0);
    expect(depleted.vEnd).toBeGreaterThan(0);
    expect(deploying.vEnd - depleted.vEnd).toBeGreaterThanOrEqual(
      CALIBRATION.DEPLETION_DELTA_MIN_KMH,
    );
  });
});

describe('real-track determinism', () => {
  it('two identical quali runs produce identical laps and final state', () => {
    const a = runQualiFlyingLap();
    const b = runQualiFlyingLap();
    expect(a.lapTimes).toEqual(b.lapTimes);
    expect(a.finalState).toBe(b.finalState);
  });
});
