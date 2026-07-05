/**
 * Longitudinal vehicle dynamics + the bang-bang driver controller.
 *
 * The sim is quasi-1D: cars move along arc length s at speed v; lateral
 * dynamics are folded into a per-sample cornering speed limit (computeVLimit).
 * All regulation-specific energy rules live in energy.ts / override.ts —
 * physics only consumes the deploy power they return.
 *
 * Braking model (both planning and actual force): decel(v) is mechanical
 * braking + aero drag, clamped so the tires never exceed downforce-scaled
 * grip. Regen under braking is treated as part of that envelope, so the
 * harvest power returned by energy.ts is NOT added as an extra force while
 * the brake is applied (it would double-count).
 */
import type { CarState, SessionKind, TrackData, TrackZone } from './types';
import { CAR, PU } from './constants';
import { onLapRollover, updateEnergy } from './energy';
import { updateOverride } from './override';

export interface StepCtx {
  session: SessionKind;
  otherCar: CarState | null;
  raceTime: number;
}

/** absolute speed cap applied to every vLimit entry, m/s */
const V_CAP = 100;
/** fraction of total load on the driven (rear) axle for traction capping */
const REAR_AXLE_SHARE = 0.62;
/** controller bands around vLimit: brake above +BRAKE_BAND; ease the throttle
 *  from full down to the steady hold value across the HOLD_BAND below the limit
 *  so the car settles onto a corner limit smoothly instead of overshooting */
const BRAKE_BAND = 0.25;
const HOLD_BAND = 3.0;
/** lift-and-coast: at zoneLift = 1 the controller lifts this many meters before the braking point */
const LIFT_RANGE_M = 150;
/** max throttle change per second — models the driver's foot, and smooths any
 *  residual hunting from racing-line curvature ripple near a corner limit */
const THROTTLE_SLEW = 9;

/** max longitudinal braking deceleration at speed v, m/s^2 (Z-mode aero) */
function brakeDecel(v: number): number {
  const mech = (CAR.BRAKE_FORCE_MAX + 0.5 * CAR.RHO_AIR * CAR.CDA_Z * v * v) / CAR.MASS;
  const grip = CAR.TIRE_MU * (CAR.G + (0.5 * CAR.RHO_AIR * CAR.CLA_Z * v * v) / CAR.MASS);
  return Math.min(mech, grip);
}

/**
 * Steady-state throttle that holds the current speed against drag + rolling
 * resistance (Z-mode aero, corner). `deployLevel` is the deploy fraction the
 * map would apply here; because deploy power scales with throttle (energy.ts),
 * the propulsion available at full throttle is ICE + deployLevel·K, and the
 * throttle to balance the resistances is a clean closed form. This replaces the
 * old bang-bang throttle/coast chatter through constant-radius corners with a
 * smooth held throttle.
 */
function holdThrottle(car: CarState, deployLevel: number): number {
  const v = Math.max(car.v, 3);
  const cdA = CAR.CDA_Z * (car.inTow ? CAR.SLIPSTREAM_CDA_FACTOR : 1);
  const resist = 0.5 * CAR.RHO_AIR * cdA * v * v + CAR.CRR * CAR.MASS * CAR.G;
  const maxPropPower = PU.ICE_POWER + deployLevel * PU.K_POWER; // at throttle 1
  const t = (resist * v) / (CAR.DRIVETRAIN_EFF * maxPropPower);
  return Math.max(0, Math.min(1, t));
}

/**
 * Per-sample speed limit profile: cornering cap from curvature (downforce-
 * aware closed form), then a backward pass so every point is reachable under
 * brakeDecel. The loop is iterated twice so the limit propagates across the
 * start/finish wrap.
 *
 * kappaOverride (optional) substitutes the racing-line curvature from
 * computeRacingLine for the raw centerline kappa — same length/indexing as
 * track.samples. Default behavior (centerline kappa) is unchanged.
 */
export function computeVLimit(track: TrackData, kappaOverride?: Float32Array): Float32Array {
  const n = track.samples.length;
  const out = new Float32Array(n);
  const m = CAR.MASS;
  const liftPerV2 = 0.5 * CAR.RHO_AIR * CAR.CLA_Z;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(kappaOverride ? kappaOverride[i] : track.samples[i].kappa);
    // m v^2 k <= mu (m g + liftPerV2 v^2)  =>  v^2 = mu m g / (m k - mu liftPerV2)
    const denom = m * k - CAR.TIRE_MU * liftPerV2;
    out[i] = denom > 0 ? Math.min(V_CAP, Math.sqrt((CAR.TIRE_MU * m * CAR.G) / denom)) : V_CAP;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = out[(i + 1) % n];
      const reachable = Math.sqrt(next * next + 2 * brakeDecel(next) * track.ds);
      if (reachable < out[i]) out[i] = reachable;
    }
  }
  return out;
}

/** is s inside [sStart, sEnd), allowing spans that wrap the start/finish line */
function inSpan(s: number, sStart: number, sEnd: number): boolean {
  return sStart <= sEnd ? s >= sStart && s < sEnd : s >= sStart || s < sEnd;
}

function zoneAt(track: TrackData, s: number): TrackZone {
  for (const z of track.zones) {
    if (inSpan(s, z.sStart, z.sEnd)) return z;
  }
  return track.zones[0];
}

function inStraightModeZone(track: TrackData, s: number): boolean {
  for (const span of track.straightModeZones) {
    if (inSpan(s, span.sStart, span.sEnd)) return true;
  }
  return false;
}

/** did the car pass lineS this tick? prevS is wrapped, rawNewS may exceed track length */
function crossedForward(prevS: number, rawNewS: number, lineS: number): boolean {
  return prevS < lineS && rawNewS >= lineS;
}

/**
 * Time gap from `behind` to `ahead`: arc distance ahead along the lap
 * (wrap-aware, laps ignored) divided by the chasing car's speed, floored at
 * 20 m/s so grid-speed gaps stay finite.
 */
export function timeGapSeconds(behind: CarState, ahead: CarState, track: TrackData): number {
  const dist = (ahead.s - behind.s + track.length) % track.length;
  return dist / Math.max(behind.v, 20);
}

/**
 * Driver controller against the vLimit profile. Scans ahead for upcoming
 * limits, using brakeDecel evaluated at the (slower) target speed — the same
 * conservative rate as the backward pass — so braking always starts before
 * the corner. With zoneLift > 0 the car coasts (harvesting) for up to
 * LIFT_RANGE_M before the point where braking would begin.
 *
 * Returns a continuous throttle in [0,1] plus a brake flag. On the straights
 * and under acceleration the throttle is 1; approaching a constant-radius
 * corner it blends smoothly down to holdThrottle and holds there (no bang-bang
 * chatter). deployLevel is the map's deploy fraction here — passed so the hold
 * throttle accounts for deploy's contribution to propulsion.
 */
function decide(
  car: CarState,
  track: TrackData,
  vLimit: Float32Array,
  deployLevel: number,
  lift: number,
  dt: number,
): { throttle: number; brake: boolean } {
  const n = vLimit.length;
  const ds = track.ds;
  const v = car.v;
  const i = Math.min(n - 1, Math.floor(car.s / ds));
  const limNow = vLimit[i];
  const margin = 2 * v * dt + 0.5;
  const offset = car.s - i * ds;
  const horizon = Math.min(n - 1, Math.ceil((v * v) / (2 * brakeDecel(0) * ds)) + 3);
  let minSlack = Infinity;
  for (let j = 1; j <= horizon; j++) {
    const lim = vLimit[(i + j) % n];
    if (lim >= v) continue;
    const dNeed = (v * v - lim * lim) / (2 * brakeDecel(lim));
    const slack = j * ds - offset - dNeed;
    if (slack < minSlack) minSlack = slack;
  }
  // brake for an over-limit speed or an upcoming slower corner
  if (v > limNow + BRAKE_BAND || minSlack <= margin) return { throttle: 0, brake: true };
  // manual deploy (SPACE) forces full throttle so the driver can put energy down
  if (car.inputs.boostHeld && car.energy.soc > 1) return { throttle: 1, brake: false };
  // lift-and-coast: harvest by coasting before the braking point
  if (minSlack <= margin + lift * LIFT_RANGE_M) return { throttle: 0, brake: false };
  // Anticipation target: the most restrictive limit over a short window ahead,
  // so the car eases toward a corner it is about to reach instead of
  // accelerating into it and then hard-braking (the source of trail-brake
  // chatter). Hard braking for distant corners is still handled by minSlack.
  let vTarget = limNow;
  const look = Math.min(n - 1, Math.ceil(20 / ds));
  for (let j = 1; j <= look; j++) {
    const l = vLimit[(i + j) % n];
    if (l < vTarget) vTarget = l;
  }
  // hysteresis: once the brakes are on, hold them continuously down to the
  // anticipated target instead of stuttering on/off through the braking zone
  if (car.brake > 0 && v > vTarget + 0.1) return { throttle: 0, brake: true };
  // slightly above the anticipated limit — coast down gently (drag only)
  if (v > vTarget + BRAKE_BAND) return { throttle: 0, brake: false };
  // no binding corner (drag-limited straight) — hold full throttle
  if (vTarget >= V_CAP - 1e-3) return { throttle: 1, brake: false };
  // well below the anticipated limit — accelerate at full throttle
  if (v <= vTarget - HOLD_BAND) return { throttle: 1, brake: false };
  // settling into / holding the corner limit: ease from full throttle to the
  // steady hold value across HOLD_BAND, then hold (eliminates the chatter)
  const hold = holdThrottle(car, deployLevel);
  const frac = Math.min(1, Math.max(0, (vTarget - v) / HOLD_BAND));
  return { throttle: hold + (1 - hold) * frac, brake: false };
}

function isInTow(car: CarState, other: CarState | null, track: TrackData): boolean {
  if (!other) return false;
  const distAhead = (other.s - car.s + track.length) % track.length;
  return distAhead > 0 && distAhead / Math.max(car.v, 1) <= CAR.SLIPSTREAM_MAX_GAP;
}

/**
 * Advance one car by dt (semi-implicit Euler). Mutates car in place.
 * Per-tick order: controller -> aero/tow flags -> energy (deploy power) ->
 * forces -> integrate -> lap/sector timing -> override state machine.
 */
export function stepCar(
  car: CarState,
  track: TrackData,
  vLimit: Float32Array,
  ctx: StepCtx,
  dt: number,
): void {
  const prevS = car.s;
  const zone = zoneAt(track, car.s);
  const deployLevel = Math.min(1, Math.max(0, (car.deployMap.zoneDeploy[zone.id] ?? 0) * car.inputs.aggressiveness));
  const decision = decide(car, track, vLimit, deployLevel, car.deployMap.zoneLift[zone.id] ?? 0, dt);
  // slew-rate-limit the throttle (a real foot can't step instantly) so it moves
  // smoothly toward the target — braking stays instant for safety
  if (decision.brake) {
    car.throttle = 0;
    car.brake = 1;
  } else {
    const maxStep = THROTTLE_SLEW * dt;
    const d = decision.throttle - car.throttle;
    car.throttle = Math.abs(d) <= maxStep ? decision.throttle : car.throttle + Math.sign(d) * maxStep;
    car.brake = 0;
  }
  car.aeroMode = car.throttle >= 0.999 && inStraightModeZone(track, car.s) ? 'X' : 'Z';
  car.inTow = isInTow(car, ctx.otherCar, track);

  const deployW = updateEnergy(car, zone, ctx, dt);
  car.deployPowerW = deployW;

  const m = CAR.MASS;
  const cdA =
    (car.aeroMode === 'X' ? CAR.CDA_X : CAR.CDA_Z) * (car.inTow ? CAR.SLIPSTREAM_CDA_FACTOR : 1);
  const clA = car.aeroMode === 'X' ? CAR.CLA_X : CAR.CLA_Z;
  const roll = CAR.CRR * m * CAR.G;
  let force: number;
  if (car.brake > 0) {
    force = -(m * brakeDecel(car.v) + roll);
  } else {
    const drag = 0.5 * CAR.RHO_AIR * cdA * car.v * car.v;
    const driveW = PU.ICE_POWER * car.throttle + deployW;
    const traction =
      CAR.TIRE_MU * REAR_AXLE_SHARE * (m * CAR.G + 0.5 * CAR.RHO_AIR * clA * car.v * car.v);
    const driveF = Math.min((CAR.DRIVETRAIN_EFF * driveW) / Math.max(car.v, 3), traction);
    force = driveF - drag - roll;
    // never let propulsion carry the car past its grip-limited corner speed:
    // cap the net force so v settles at the limit instead of overshooting and
    // triggering a brake (excess deploy here is simply wasted — as it is in
    // reality, and as the optimizer already penalises)
    const iNow = Math.min(vLimit.length - 1, Math.floor(car.s / track.ds));
    const maxForce = (m * (vLimit[iNow] - car.v)) / dt;
    if (force > maxForce) force = maxForce;
  }
  car.v = Math.max(0, car.v + (force / m) * dt);

  const rawS = car.s + car.v * dt;
  car.totalTime += dt;
  car.currentLapTime += dt;
  if (crossedForward(prevS, rawS, track.sector2S)) {
    car.currentSectors = [car.currentLapTime];
  }
  if (crossedForward(prevS, rawS, track.sector3S) && car.currentSectors.length >= 1) {
    car.currentSectors[1] = car.currentLapTime - car.currentSectors[0];
  }
  if (rawS >= track.length) {
    car.s = rawS - track.length;
    car.lap += 1;
    const overshoot = car.v > 0 ? car.s / car.v : 0;
    const lapTime = car.currentLapTime - overshoot;
    car.lapTimes.push(lapTime);
    if (car.bestLap === null || lapTime < car.bestLap) car.bestLap = lapTime;
    if (car.currentSectors.length >= 2) {
      car.currentSectors[2] = lapTime - car.currentSectors[0] - car.currentSectors[1];
    }
    car.currentLapTime = overshoot;
    onLapRollover(car);
  } else {
    car.s = rawS;
  }
  car.gear = Math.max(1, Math.min(8, 1 + Math.floor(car.v / 12)));

  updateOverride(car, ctx.otherCar, track, ctx, prevS, car.s);
}
