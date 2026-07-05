import { describe, expect, it } from 'vitest';
import { PU, SIM, deployCapNormalW, deployCapOverrideW } from '../src/sim/constants';
import { onLapRollover, updateEnergy } from '../src/sim/energy';
import { computeVLimit, stepCar, type StepCtx } from '../src/sim/physics';
import type { TrackZone } from '../src/sim/types';
import { makeCar, makeSyntheticTrack } from './synthetic';

const DT = SIM.DT;

const track = makeSyntheticTrack({ kind: 'stadium', straight: 700, radius: 60 });

function ctx(session: 'race' | 'quali'): StepCtx {
  return { session, otherCar: null, raceTime: 0 };
}

function zone(accelZone = true): TrackZone {
  return { id: 0, name: 'z', sStart: 0, sEnd: 100, kind: 'straight', accelZone };
}

/** car mid-straight at speed v (m/s), throttle/brake preset by each test */
function carAt(v: number): ReturnType<typeof makeCar> {
  const car = makeCar('player', track, { v, throttle: 1, brake: 0 });
  return car;
}

describe('deploy caps', () => {
  it('deploys zoneDeploy * aggressiveness * K_POWER below the taper', () => {
    const car = carAt(60);
    car.deployMap.zoneDeploy[0] = 0.5;
    car.inputs.aggressiveness = 1.25;
    const p = updateEnergy(car, zone(), ctx('quali'), DT);
    expect(p).toBeCloseTo(0.5 * 1.25 * PU.K_POWER, 3);
    expect(car.energy.soc).toBeCloseTo(PU.ES_WINDOW - p * DT, 3);
    expect(car.energy.deployedThisLap).toBeCloseTo(p * DT, 3);
  });

  it('caps by the normal taper, or the override taper when overrideActive', () => {
    const v = 324 / 3.6;
    const normal = carAt(v);
    expect(updateEnergy(normal, zone(), ctx('quali'), DT)).toBeCloseTo(deployCapNormalW(324), 3);
    const boosted = carAt(v);
    boosted.energy.overrideActive = true;
    expect(updateEnergy(boosted, zone(), ctx('quali'), DT)).toBeCloseTo(deployCapOverrideW(324), 3);
    expect(deployCapOverrideW(324)).toBe(350e3);
  });

  it('caps at NON_ACCEL_ZONE_CAP outside acceleration zones in races only', () => {
    const race = carAt(60);
    expect(updateEnergy(race, zone(false), ctx('race'), DT)).toBeCloseTo(
      PU.NON_ACCEL_ZONE_CAP,
      3,
    );
    const quali = carAt(60);
    expect(updateEnergy(quali, zone(false), ctx('quali'), DT)).toBeCloseTo(PU.K_POWER, 3);
  });

  it('caps by available SoC and cuts to zero on an empty battery', () => {
    const car = carAt(60);
    car.energy.soc = 1000;
    car.energy.lastDeployPowerW = 350e3;
    const p = updateEnergy(car, zone(), ctx('quali'), DT);
    expect(p).toBeCloseTo(1000 / DT, 3);
    expect(car.energy.soc).toBeCloseTo(0, 3);
    // empty-battery exception: straight to zero, ignoring the ramp-down floor
    const p2 = updateEnergy(car, zone(), ctx('quali'), DT);
    expect(p2).toBe(0);
  });
});

describe('ramp-down clip rule', () => {
  it('bounds dP/dt at -RAMP_DOWN_LIMIT across a forced taper crossing', () => {
    // scripted 8 km/h/s sweep: the -5 leg demands -40 kW/s, the -20 leg
    // -160 kW/s, so the clip floor must take over above 340
    const car = carAt(280 / 3.6);
    let lastP = updateEnergy(car, zone(), ctx('quali'), DT);
    let sawFloorAboveTaper = false;
    for (let vKmh = 280; vKmh < 352; vKmh += 8 * DT) {
      car.v = vKmh / 3.6;
      car.energy.soc = PU.ES_WINDOW;
      const p = updateEnergy(car, zone(), ctx('quali'), DT);
      expect(p - lastP).toBeGreaterThanOrEqual(-PU.RAMP_DOWN_LIMIT * DT - 1e-6);
      if (p > deployCapNormalW(vKmh) + 1) sawFloorAboveTaper = true;
      lastP = p;
    }
    expect(sawFloorAboveTaper).toBe(true);
    expect(lastP).toBeGreaterThan(0); // still bleeding down past 345 at 50 kW/s
  });

  it('ramps down toward a lowered zone target instead of stepping', () => {
    const car = carAt(60);
    car.energy.lastDeployPowerW = 350e3;
    // full throttle with a lowered (non-zero) deploy target: the 50 kW/s clip
    // governs the ramp-down. (A partial throttle is a lift-off and clip-exempt;
    // a zero target at full throttle would superclip — so use a low positive one.)
    car.deployMap.zoneDeploy[0] = 0.2;
    car.throttle = 1;
    const p = updateEnergy(car, zone(), ctx('quali'), DT);
    expect(p).toBeCloseTo(350e3 - PU.RAMP_DOWN_LIMIT * DT, 3);
  });
});

describe('harvesting', () => {
  it('brake regen respects the race per-lap cap exactly', () => {
    const car = carAt(80);
    car.throttle = 0;
    car.brake = 1;
    for (let t = 0; t < 40 / DT; t++) {
      car.energy.soc = 0; // keep ES headroom out of the way
      const p = updateEnergy(car, zone(), ctx('race'), DT);
      expect(p).toBeLessThanOrEqual(0);
      expect(car.energy.harvestedThisLap).toBeLessThanOrEqual(PU.HARVEST_CAP_RACE + 1e-6);
    }
    expect(car.energy.harvestedThisLap).toBeCloseTo(PU.HARVEST_CAP_RACE, 0);
  });

  it('quali uses the lower per-lap cap', () => {
    const car = carAt(80);
    car.throttle = 0;
    car.brake = 1;
    for (let t = 0; t < 40 / DT; t++) {
      car.energy.soc = 0;
      updateEnergy(car, zone(), ctx('quali'), DT);
      expect(car.energy.harvestedThisLap).toBeLessThanOrEqual(PU.HARVEST_CAP_QUALI + 1e-6);
    }
    expect(car.energy.harvestedThisLap).toBeCloseTo(PU.HARVEST_CAP_QUALI, 0);
  });

  it('an armed override extends the lap cap by up to OVERRIDE_BONUS', () => {
    const car = carAt(80);
    car.throttle = 0;
    car.brake = 1;
    car.energy.overrideArmed = true;
    car.energy.overrideBonusRemaining = PU.OVERRIDE_BONUS;
    for (let t = 0; t < 40 / DT; t++) {
      car.energy.soc = 0;
      updateEnergy(car, zone(), ctx('race'), DT);
    }
    expect(car.energy.harvestedThisLap).toBeCloseTo(PU.HARVEST_CAP_RACE + PU.OVERRIDE_BONUS, 0);
    expect(car.energy.overrideBonusRemaining).toBeCloseTo(0, 0);
  });

  it('brake regen stops at the top of the ES window', () => {
    const car = carAt(80);
    car.throttle = 0;
    car.brake = 1;
    car.energy.soc = PU.ES_WINDOW - 500;
    const p = updateEnergy(car, zone(), ctx('race'), DT);
    expect(-p * DT).toBeCloseTo(500, 3);
    expect(car.energy.soc).toBeCloseTo(PU.ES_WINDOW, 3);
    expect(updateEnergy(car, zone(), ctx('race'), DT)).toBe(0);
  });

  it('lift-and-coast harvests at zoneLift * BRAKE_REGEN_MAX * 0.6', () => {
    const car = carAt(70);
    car.throttle = 0;
    car.brake = 0;
    car.energy.soc = 1e6;
    car.deployMap.zoneLift[0] = 0.5;
    const p = updateEnergy(car, zone(), ctx('race'), DT);
    expect(p).toBeCloseTo(-0.5 * PU.BRAKE_REGEN_MAX * 0.6, 3);
    const idle = carAt(70);
    idle.throttle = 0;
    expect(updateEnergy(idle, zone(), ctx('race'), DT)).toBe(0); // zoneLift 0: plain coast
  });

  it('superclips at full throttle when zoneDeploy is 0, ramping through zero', () => {
    const car = carAt(70);
    car.deployMap.zoneDeploy[0] = 0;
    car.energy.soc = 1e6;
    car.energy.lastDeployPowerW = 100e3;
    let p = 0;
    let lastP = car.energy.lastDeployPowerW;
    let minStep = 0;
    for (let t = 0; t < 12 / DT; t++) {
      p = updateEnergy(car, zone(), ctx('quali'), DT);
      minStep = Math.min(minStep, p - lastP);
      lastP = p;
      if (p === -PU.SUPERCLIP_HARVEST) break;
    }
    expect(p).toBe(-PU.SUPERCLIP_HARVEST); // reaches full superclip recharge
    expect(minStep).toBeGreaterThanOrEqual(-PU.RAMP_DOWN_LIMIT * DT - 1e-6);
    expect(car.energy.soc).toBeGreaterThan(1e6); // battery actually charged
    expect(car.energy.harvestedThisLap).toBeGreaterThan(0);
  });
});

describe('onLapRollover', () => {
  it('resets per-lap counters and regrants the bonus only while armed', () => {
    const car = carAt(50);
    car.energy.harvestedThisLap = 5e6;
    car.energy.deployedThisLap = 7e6;
    car.energy.overrideArmed = true;
    onLapRollover(car);
    expect(car.energy.harvestedThisLap).toBe(0);
    expect(car.energy.deployedThisLap).toBe(0);
    expect(car.energy.overrideBonusRemaining).toBe(PU.OVERRIDE_BONUS);
    car.energy.overrideArmed = false;
    onLapRollover(car);
    expect(car.energy.overrideBonusRemaining).toBe(0);
  });
});

describe('full-deploy laps on the stadium track', () => {
  it('keeps soc in [0, ES_WINDOW] and the energy books balanced', () => {
    const vLimit = computeVLimit(track);
    const car = makeCar('player', track);
    car.deployMap.zoneLift = track.zones.map(() => 0.5);
    const c = ctx('race');
    for (let t = 0; t < 120 / DT && car.lap < 3; t++) {
      stepCar(car, track, vLimit, c, DT);
      const e = car.energy;
      expect(e.soc).toBeGreaterThanOrEqual(0);
      expect(e.soc).toBeLessThanOrEqual(PU.ES_WINDOW + 1e-6);
      // everything deployed came from the (<= 4 MJ) starting window + harvest
      expect(e.deployedThisLap).toBeLessThanOrEqual(PU.ES_WINDOW + e.harvestedThisLap + 1);
      expect(e.harvestedThisLap).toBeLessThanOrEqual(PU.HARVEST_CAP_RACE + 1e-6);
    }
    expect(car.lap).toBeGreaterThanOrEqual(3);
    expect(car.lapTimes.length).toBeGreaterThanOrEqual(3);
  });
});
