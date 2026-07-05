/**
 * Manual Override ("Overtake") state machine per FIA B7.2.
 *
 * Race: crossing the Detection Line within DETECTION_GAP seconds of a car
 * ahead earns a pending arm; the arm takes effect at the next Activation Line
 * crossing and persists until the following Activation Line crossing (~a full
 * lap), where it is re-evaluated from the latest detection result.
 * Quali: override is enabled and armed at all times (B7.2.2.a / B7.2.3.b).
 *
 * Lap-1 rule (B7.2.2.b — override disabled until the leader has crossed the
 * Detection Line once): satisfied by construction in this two-car sim rather
 * than by an explicit flag. Cars move forward continuously, so by the time
 * any car reaches the Detection Line every car ahead of it — in particular
 * the leader — has already crossed it; and the leader itself has no car
 * ahead, so it can never arm. An explicit enable flag would therefore never
 * change behavior here.
 *
 * pendingArm is sub-lap bookkeeping with no slot in the EnergyState contract;
 * it lives in a WeakMap keyed by the CarState object, so parallel sims stay
 * independent and deterministic.
 */
import type { CarState, TrackData } from './types';
import type { StepCtx } from './physics';
import { OVERRIDE, PU } from './constants';
import { timeGapSeconds } from './physics';

interface OverrideMem {
  pendingArm: boolean;
}

const mem = new WeakMap<CarState, OverrideMem>();

/** did the car pass lineS while moving prevS -> newS (both wrapped)? */
function crossed(prevS: number, newS: number, lineS: number, length: number): boolean {
  const moved = (newS - prevS + length) % length;
  if (moved <= 0) return false;
  const toLine = (lineS - prevS + length) % length;
  return toLine > 0 && toLine <= moved;
}

/**
 * Advance override state for one tick. Call after the car has moved;
 * prevS/newS are the wrapped positions before/after integration. Sets
 * energy.overrideArmed / overrideActive (and grants the harvest bonus on
 * arming in races; quali laps regrant it via onLapRollover).
 */
export function updateOverride(
  car: CarState,
  otherCar: CarState | null,
  track: TrackData,
  ctx: StepCtx,
  prevS: number,
  newS: number,
): void {
  const e = car.energy;
  if (ctx.session === 'quali') {
    e.overrideArmed = true;
  } else {
    let m = mem.get(car);
    if (!m) {
      m = { pendingArm: false };
      mem.set(car, m);
    }
    if (crossed(prevS, newS, track.detectionLineS, track.length)) {
      m.pendingArm =
        otherCar !== null && timeGapSeconds(car, otherCar, track) < OVERRIDE.DETECTION_GAP;
    }
    if (crossed(prevS, newS, track.activationLineS, track.length)) {
      const wasArmed = e.overrideArmed;
      e.overrideArmed = m.pendingArm;
      m.pendingArm = false;
      if (e.overrideArmed) e.overrideBonusRemaining = PU.OVERRIDE_BONUS;
      else if (wasArmed) e.overrideBonusRemaining = 0;
    }
  }
  e.overrideActive = e.overrideArmed && car.inputs.boostHeld && e.soc > 0;
}
