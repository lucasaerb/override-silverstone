import { describe, expect, it } from 'vitest';
import { PU, SIM, deployCapNormalW, deployCapOverrideW } from '../src/sim/constants';
import { updateEnergy } from '../src/sim/energy';
import { computeVLimit, stepCar, type StepCtx } from '../src/sim/physics';
import { updateOverride } from '../src/sim/override';
import type { CarState, TrackZone } from '../src/sim/types';
import { makeCar, makeSyntheticTrack } from './synthetic';

const DT = SIM.DT;

// detection late on straight-2, activation on straight-1 well after the line,
// so a lap holds exactly one detection followed by one activation crossing
const track = makeSyntheticTrack({
  kind: 'stadium',
  straight: 700,
  radius: 60,
  detectionLineS: 700 + Math.PI * 60 + 500,
  activationLineS: 100,
});
const vLimit = computeVLimit(track);

/**
 * Step the follower through the full stepCar pipeline until it has crossed
 * lineS `times` times, with a scripted hare pinned `gapMeters` ahead each
 * tick (a controlled, collision-free gap; co-simulating two cars lets the
 * slipstreaming follower drive through the leader). At straight speeds
 * ~75-85 m/s, 50 m reads as ~0.6-0.7 s and 120 m as ~1.4-1.6 s.
 */
function runUntilCrossings(
  follower: CarState,
  hare: CarState,
  gapMeters: number,
  lineS: number,
  times: number,
  maxSeconds = 120,
): void {
  let seen = 0;
  for (let t = 0; t < maxSeconds / DT; t++) {
    hare.s = (follower.s + gapMeters) % track.length;
    hare.v = follower.v;
    const prevS = follower.s;
    stepCar(follower, track, vLimit, { session: 'race', otherCar: hare, raceTime: t * DT }, DT);
    if (prevS < lineS && follower.s >= lineS) seen++;
    else if (follower.s < prevS && lineS > prevS) seen++; // wrapped past it
    if (seen >= times) return;
  }
  throw new Error(`only saw ${seen}/${times} crossings of s=${lineS}`);
}

function pair(v = 55) {
  const hare = makeCar('rival', track, { v });
  const follower = makeCar('player', track, { s: 300, v });
  return { hare, follower };
}

describe('race detection and arming', () => {
  it('a follower ~0.7 s back at the detection line arms at the activation line', () => {
    const { hare, follower } = pair();
    runUntilCrossings(follower, hare, 50, track.detectionLineS, 1);
    expect(follower.energy.overrideArmed).toBe(false); // pending until activation
    runUntilCrossings(follower, hare, 50, track.activationLineS, 1);
    expect(follower.energy.overrideArmed).toBe(true);
    expect(follower.energy.overrideBonusRemaining).toBe(PU.OVERRIDE_BONUS);
  });

  it('a follower ~1.5 s back does NOT arm', () => {
    const { hare, follower } = pair();
    runUntilCrossings(follower, hare, 120, track.detectionLineS, 1);
    runUntilCrossings(follower, hare, 120, track.activationLineS, 1);
    expect(follower.energy.overrideArmed).toBe(false);
  });

  it('an armed override expires at the next activation crossing if not re-earned', () => {
    const { hare, follower } = pair();
    runUntilCrossings(follower, hare, 50, track.detectionLineS, 1);
    runUntilCrossings(follower, hare, 50, track.activationLineS, 1);
    expect(follower.energy.overrideArmed).toBe(true);
    // hare escapes; armed must persist through the lap...
    runUntilCrossings(follower, hare, 120, track.detectionLineS, 1);
    expect(follower.energy.overrideArmed).toBe(true);
    // ...and drop at the next activation line
    runUntilCrossings(follower, hare, 120, track.activationLineS, 1);
    expect(follower.energy.overrideArmed).toBe(false);
    expect(follower.energy.overrideBonusRemaining).toBe(0);
  });

  it('overrideActive requires armed + boost held + charge', () => {
    const car = makeCar('player', track, { s: 400, v: 60 }); // away from both lines
    car.energy.overrideArmed = true;
    const ctx: StepCtx = { session: 'race', otherCar: null, raceTime: 0 };
    stepCar(car, track, vLimit, ctx, DT);
    expect(car.energy.overrideArmed).toBe(true); // persists between activation crossings
    expect(car.energy.overrideActive).toBe(false); // boost not held
    car.inputs.boostHeld = true;
    stepCar(car, track, vLimit, ctx, DT);
    expect(car.energy.overrideActive).toBe(true);
    car.energy.soc = 0;
    stepCar(car, track, vLimit, ctx, DT);
    expect(car.energy.overrideActive).toBe(false); // flat battery
  });
});

describe('quali', () => {
  it('override is always armed, active whenever boost is held', () => {
    const car = makeCar('player', track, { s: 400, v: 60 });
    const ctx: StepCtx = { session: 'quali', otherCar: null, raceTime: 0 };
    stepCar(car, track, vLimit, ctx, DT);
    expect(car.energy.overrideArmed).toBe(true);
    expect(car.energy.overrideActive).toBe(false);
    car.inputs.boostHeld = true;
    stepCar(car, track, vLimit, ctx, DT);
    expect(car.energy.overrideActive).toBe(true);
  });
});

describe('override power advantage', () => {
  const powerZone: TrackZone = {
    id: 0,
    name: 'z',
    sStart: 0,
    sEnd: 100,
    kind: 'straight',
    accelZone: true,
  };

  /**
   * Deploy power through updateEnergy at vKmh with/without override.
   * Quali context + lastDeployPowerW = 0 releases the clip floor and the
   * race-only activation step cap, exposing the raw taper.
   */
  function deployAt(vKmh: number, override: boolean): number {
    const car = makeCar('player', track, { v: vKmh / 3.6, throttle: 1 });
    car.energy.overrideActive = override;
    car.energy.lastDeployPowerW = 0;
    return updateEnergy(car, powerZone, { session: 'quali', otherCar: null, raceTime: 0 }, DT);
  }

  it('an active override out-deploys normal mode at the top of the taper', () => {
    // C5.2.8: at 337.5 km/h override still has the full 350 kW vs ~112 kW
    // normal; at 340 it is 300 vs 100 kW; at 345 the defender has nothing
    expect(deployAt(337.5, true)).toBeCloseTo(350e3, 0);
    expect(deployAt(337.5, false)).toBeCloseTo(deployCapNormalW(337.5), 0);
    expect(deployAt(340, true)).toBeCloseTo(300e3, 0);
    expect(deployAt(340, false)).toBeCloseTo(100e3, 0);
    expect(deployAt(345, true)).toBeCloseTo(deployCapOverrideW(345), 0);
    expect(deployAt(345, false)).toBe(0);
  });

  it('race activation step is capped at +OVERRIDE_STEP_CAP over the last deploy level', () => {
    const car = makeCar('player', track, { v: 330 / 3.6, throttle: 1 });
    car.energy.overrideActive = true;
    car.energy.lastDeployPowerW = 100e3; // deploy level at the moment of activation
    const p = updateEnergy(car, powerZone, { session: 'race', otherCar: null, raceTime: 0 }, DT);
    expect(p).toBeCloseTo(100e3 + PU.OVERRIDE_STEP_CAP, 3);
    // no such cap in quali: straight to the 350 kW override cap at 330
    const q = makeCar('player', track, { v: 330 / 3.6, throttle: 1 });
    q.energy.overrideActive = true;
    q.energy.lastDeployPowerW = 100e3;
    expect(
      updateEnergy(q, powerZone, { session: 'quali', otherCar: null, raceTime: 0 }, DT),
    ).toBeCloseTo(350e3, 3);
  });
});

describe('updateOverride line crossings', () => {
  it('detects crossings across the start/finish wrap', () => {
    const wrapTrack = makeSyntheticTrack({
      kind: 'stadium',
      straight: 700,
      radius: 60,
      detectionLineS: 5, // just past the line: reached via a wrapped step
      activationLineS: 200,
    });
    const leader = makeCar('rival', wrapTrack, { s: 20, v: 55 });
    const follower = makeCar('player', wrapTrack, { s: wrapTrack.length - 2, v: 55 });
    const ctx: StepCtx = { session: 'race', otherCar: leader, raceTime: 0 };
    // one manual step: prevS near the end of the lap, newS wrapped past s=5
    updateOverride(follower, leader, wrapTrack, ctx, follower.s, 8);
    follower.s = 8;
    updateOverride(follower, leader, wrapTrack, ctx, 8, 201); // cross activation
    expect(follower.energy.overrideArmed).toBe(true);
  });
});
