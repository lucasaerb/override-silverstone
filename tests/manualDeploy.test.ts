import { describe, expect, it } from 'vitest';
import { SIM, PU, deployCapNormalW } from '../src/sim/constants';
import { updateEnergy } from '../src/sim/energy';
import { makeCar, makeSyntheticTrack } from './synthetic';
import type { CarState, TrackZone } from '../src/sim/types';

/**
 * The manual "push-to-deploy" mechanic: holding the deploy button
 * (inputs.boostHeld) requests full MGU-K power regardless of the zone map,
 * tapered by speed and gated by charge. These lock that behavior in.
 */
const DT = SIM.DT;
const track = makeSyntheticTrack({ kind: 'stadium', straight: 700, radius: 60 });
const accelZone: TrackZone = { id: 0, name: 'z', sStart: 0, sEnd: 100, kind: 'straight', accelZone: true };
const ctx = { session: 'quali' as const, otherCar: null, raceTime: 0 };

/** on-throttle car in zone 0 with the map value for that zone forced to `deploy`. */
function car(deploy: number, vKmh = 200, patch: Partial<CarState> = {}): CarState {
  const c = makeCar('player', track, { v: vKmh / 3.6, throttle: 1, ...patch });
  c.deployMap.zoneDeploy[0] = deploy;
  c.deployMap.zoneLift[0] = 0;
  c.energy.lastDeployPowerW = 0;
  return c;
}

describe('manual push-to-deploy', () => {
  it('holding deploy in a 0% zone draws full MGU-K power', () => {
    const c = car(0);
    c.inputs.boostHeld = true;
    const p = updateEnergy(c, accelZone, ctx, DT);
    expect(p).toBeCloseTo(PU.K_POWER, -3); // ~350 kW
    expect(c.energy.soc).toBeLessThan(PU.ES_WINDOW); // battery drained
  });

  it('overrides a partial map upward, not just scaling it', () => {
    const c = car(0.25);
    c.inputs.boostHeld = true;
    const p = updateEnergy(c, accelZone, ctx, DT);
    expect(p).toBeCloseTo(PU.K_POWER, -3); // full, not 0.25 * 350
  });

  it('is still limited by the speed taper', () => {
    const c = car(0, 330);
    c.inputs.boostHeld = true;
    const p = updateEnergy(c, accelZone, ctx, DT);
    expect(p).toBeCloseTo(deployCapNormalW(330), -3); // 150 kW at 330 km/h
  });

  it('does not deploy on an empty battery', () => {
    const c = car(0, 200, { energy: { ...makeCar('player', track).energy, soc: 0 } });
    c.inputs.boostHeld = true;
    const p = updateEnergy(c, accelZone, ctx, DT);
    expect(p).toBeLessThanOrEqual(0); // no positive deploy without charge
  });

  it('without the button, a 0% zone still superclip-harvests at full throttle', () => {
    const c = car(0, 200, { energy: { ...makeCar('player', track).energy, soc: 2e6 } });
    // boostHeld stays false
    const p = updateEnergy(c, accelZone, ctx, DT);
    expect(p).toBeLessThan(0); // harvesting, not deploying
  });
});
