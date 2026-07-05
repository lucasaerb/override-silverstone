/**
 * 2026 MGU-K energy rules: deploy tapers, per-lap harvest caps, the 50 kW/s
 * ramp-down ("clipping") rule, superclipping, lift-and-coast regen and the
 * Manual Override bonus. Called once per tick by physics.stepCar; the return
 * value is the deploy power in W (negative = the K is harvesting, which costs
 * drive force at full throttle / while coasting).
 *
 * Ramp-down semantics (FIA C5.12.6, sim simplification): while the throttle
 * is applied, the commanded K power may not fall faster than RAMP_DOWN_LIMIT
 * W/s — this floor WINS over the speed taper and zone caps (that is exactly
 * the real-world "clipping" tail), and carries continuously through zero into
 * superclip harvest. Exceptions (C5.12.7, modeled): empty battery cuts deploy
 * to zero instantly; braking / lift-off are negative driver demand and are
 * exempt, so their harvest steps are immediate.
 */
import type { CarState, EnergyState, TrackZone } from './types';
import type { StepCtx } from './physics';
import { PU, deployCapNormalW, deployCapOverrideW } from './constants';

/** below this SoC the battery counts as empty and deploy cuts to zero, J */
const SOC_EMPTY_J = 1;

/**
 * Harvest up to powerW for one tick, honoring the per-lap cap (base cap plus
 * the Manual Override bonus while armed — overflow past the base cap consumes
 * overrideBonusRemaining) and ES headroom. Returns the power actually stored.
 */
function harvest(e: EnergyState, race: boolean, powerW: number, dt: number): number {
  const baseCap = race ? PU.HARVEST_CAP_RACE : PU.HARVEST_CAP_QUALI;
  const baseHead = Math.max(0, baseCap - e.harvestedThisLap);
  const bonusHead = e.overrideArmed ? e.overrideBonusRemaining : 0;
  const esHead = Math.max(0, PU.ES_WINDOW - e.soc);
  const j = Math.max(0, Math.min(powerW * dt, baseHead + bonusHead, esHead));
  const fromBonus = Math.max(0, j - baseHead);
  if (fromBonus > 0) e.overrideBonusRemaining -= fromBonus;
  e.harvestedThisLap += j;
  e.soc += j;
  return j / dt;
}

/**
 * Compute this tick's MGU-K power for the car in `zone` and mutate
 * car.energy. Positive = deploy (J drawn from soc), negative = harvest.
 */
export function updateEnergy(car: CarState, zone: TrackZone, ctx: StepCtx, dt: number): number {
  const e = car.energy;
  const race = ctx.session === 'race';
  const zoneDeploy = car.deployMap.zoneDeploy[zone.id] ?? 0;
  const zoneLift = car.deployMap.zoneLift[zone.id] ?? 0;
  let p = 0;

  if (car.brake > 0) {
    p = -harvest(e, race, PU.BRAKE_REGEN_MAX, dt) || 0;
  } else if (car.throttle <= 0) {
    if (zoneLift > 0) p = -harvest(e, race, zoneLift * PU.BRAKE_REGEN_MAX * 0.6, dt) || 0;
  } else {
    const vKmh = car.v * 3.6;
    const taper = e.overrideActive ? deployCapOverrideW(vKmh) : deployCapNormalW(vKmh);
    // Manual "push-to-deploy": holding the deploy button (boostHeld) requests
    // full MGU-K power right now — tapered by speed, enhanced by the override
    // taper when armed. It overrides the zone map upward (the driver can always
    // ask for more than the strategy map dictates) and suppresses this zone's
    // superclip harvest, so the button always does something while there's charge.
    const manual = car.inputs.boostHeld && e.soc > SOC_EMPTY_J;
    let target: number;
    if (zoneDeploy === 0 && car.throttle >= 1 && !manual) {
      target = -PU.SUPERCLIP_HARVEST;
    } else {
      // deploy scales with throttle: full while accelerating (throttle = 1,
      // unchanged from before), tapered down as the driver feathers to hold a
      // corner speed limit (throttle < 1) so energy tracks actual propulsion.
      const base = manual ? 1 : Math.min(1, Math.max(0, zoneDeploy * car.inputs.aggressiveness));
      const level = manual ? base : base * car.throttle;
      target = Math.min(level * PU.K_POWER, taper);
      if (race && !zone.accelZone) target = Math.min(target, PU.NON_ACCEL_ZONE_CAP);
    }
    // 50 kW/s ramp-down applies only while the throttle is held at full — when
    // the driver feathers off to hold a corner speed (throttle < 1) that is a
    // lift-off, which the clip rule exempts, so deploy follows demand at once.
    p = car.throttle >= 0.999
      ? Math.max(target, e.lastDeployPowerW - PU.RAMP_DOWN_LIMIT * dt)
      : target;
    // Miami-package step cap: while override is active in a race, power may
    // not jump more than +150 kW over the previous deploy level. Only applied
    // from a non-negative previous level — throttle re-application after
    // braking (negative demand) is governed by other articles, not this one.
    if (race && e.overrideActive && e.lastDeployPowerW >= 0) {
      p = Math.min(p, e.lastDeployPowerW + PU.OVERRIDE_STEP_CAP);
    }
    p = Math.min(p, PU.K_POWER);
    if (p > 0) {
      p = Math.min(p, e.soc / dt);
      if (e.soc <= SOC_EMPTY_J) p = 0;
      e.soc -= p * dt;
      e.deployedThisLap += p * dt;
    } else if (p < 0) {
      p = -harvest(e, race, -p, dt) || 0;
    }
  }

  e.lastDeployPowerW = p;
  e.soc = Math.min(Math.max(e.soc, 0), PU.ES_WINDOW);
  return p;
}

/**
 * Reset the per-lap counters at the start/finish line. The override harvest
 * bonus regrants only if the car carries an armed override across the line
 * (in quali, where override is always armed, that is every lap).
 */
export function onLapRollover(car: CarState): void {
  const e = car.energy;
  e.harvestedThisLap = 0;
  e.deployedThisLap = 0;
  e.overrideBonusRemaining = e.overrideArmed ? PU.OVERRIDE_BONUS : 0;
}
