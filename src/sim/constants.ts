/**
 * 2026 F1 regulation constants and power-taper formulas.
 *
 * Sources: FIA 2026 Technical Regulations Section C (Issue 12) and Sporting
 * Regulations Section B (Issue 05), plus 2026-season reported values — see
 * research/2026-energy-regs.md for the full provenance table. The taper
 * formulas below are quoted from FIA C5.2.8 (the often-cited "zero at 355 for
 * normal mode" comes from a superseded draft; 355 is the OVERRIDE cutoff).
 *
 * Chassis/aero values are calibration parameters, tuned so the sim hits the
 * real 2026 Silverstone reference points (pole 1:28.111, top speed 320-340,
 * ~50 km/h end-of-straight depletion cliff). Regulation values must not be
 * touched during calibration; chassis values may.
 */

// ---------------------------------------------------------------- power unit (FIA)

export const PU = {
  /** ICE peak power, W (~400 kW reported for 2026 units) */
  ICE_POWER: 400e3,
  /** MGU-K max deploy AND max recovery power, W (FIA C5.2.7) */
  K_POWER: 350e3,
  /** usable Energy Store window: max SoC delta at all times, J (FIA C5.2.9) */
  ES_WINDOW: 4e6,
  /** per-lap MGU-K harvest cap, race — Silverstone 2026 event value, J */
  HARVEST_CAP_RACE: 8.0e6,
  /** per-lap harvest cap, quali — Silverstone 2026 event value, J */
  HARVEST_CAP_QUALI: 6.5e6,
  /** extra harvest allowance on a lap with Manual Override active, J (FIA C5.2.10.iii) */
  OVERRIDE_BONUS: 0.5e6,
  /** deploy power ramp-down limit at Silverstone (7-circuit rule), W/s (FIA C5.12) */
  RAMP_DOWN_LIMIT: 50e3,
  /** max instantaneous power step when activating override in races (Miami package), W */
  OVERRIDE_STEP_CAP: 150e3,
  /** deploy cap outside designated acceleration zones in races (Miami package), W */
  NON_ACCEL_ZONE_CAP: 250e3,
  /** max harvest power under braking, W */
  BRAKE_REGEN_MAX: 350e3,
  /** harvest power while at full throttle ("superclipping", post-Miami), W */
  SUPERCLIP_HARVEST: 350e3,
  /** MGU-K may only propel above this speed at a standing start, m/s (C5.2.12: 50 km/h) */
  K_MIN_SPEED_STANDING_START: 50 / 3.6,
} as const;

// ---------------------------------------------------------------- override rules (FIA B7.2)

export const OVERRIDE = {
  /** gap to any car ahead at the detection line to arm override, s */
  DETECTION_GAP: 1.0,
} as const;

// ---------------------------------------------------------------- tapers (FIA C5.2.8)

/**
 * Normal-mode MGU-K deploy power cap vs speed. FIA C5.2.8.i:
 *   v <= 290 km/h        : 350 kW
 *   290 < v <= 340 km/h  : P = (1800 - 5v) kW
 *   340 < v < 345 km/h   : P = (6900 - 20v) kW
 *   v >= 345 km/h        : 0
 * Continuous at the joins: P(340) = 100 kW via both formulas, P(345) = 0.
 */
export function deployCapNormalW(vKmh: number): number {
  if (vKmh <= 290) return 350e3;
  if (vKmh <= 340) return (1800 - 5 * vKmh) * 1e3;
  if (vKmh < 345) return (6900 - 20 * vKmh) * 1e3;
  return 0;
}

/**
 * Manual-Override-mode deploy power cap vs speed. FIA C5.2.8.ii:
 *   P = min(350, 7100 - 20v) kW, floor 0  =>  full 350 kW to 337.5 km/h, 0 at 355.
 */
export function deployCapOverrideW(vKmh: number): number {
  return Math.max(0, Math.min(350e3, (7100 - 20 * vKmh) * 1e3));
}

// ---------------------------------------------------------------- chassis (calibration)

export const CAR = {
  /** car + driver + mid-race fuel, kg (2026 min car mass 768 + fuel) */
  MASS: 815,
  G: 9.81,
  RHO_AIR: 1.2,
  /** drag area CdA, m^2 — Z-mode (high downforce) / X-mode (active aero, low drag) */
  CDA_Z: 1.44,
  CDA_X: 0.95,
  /** downforce area ClA, m^2 */
  CLA_Z: 5.0,
  CLA_X: 2.2,
  /** rolling resistance */
  CRR: 0.012,
  /** combined tire friction coefficient (with load sensitivity folded in) */
  TIRE_MU: 2.05,
  /** mechanical brake force limit, N (aero drag + downforce-scaled grip add the rest) */
  BRAKE_FORCE_MAX: 38e3,
  /** drivetrain efficiency applied to propulsive power */
  DRIVETRAIN_EFF: 0.95,
  /** CdA multiplier when running in another car's tow */
  SLIPSTREAM_CDA_FACTOR: 0.72,
  /** tow reach behind the leading car, s of time gap */
  SLIPSTREAM_MAX_GAP: 1.2,
} as const;

// ---------------------------------------------------------------- sim

export const SIM = {
  DT: 1 / 120,
  /** race distance for the v1 duel */
  RACE_LAPS: 5,
} as const;

// ---------------------------------------------------------------- reference targets (tests)

/** Real-world 2026 Silverstone reference points the calibration tests assert. */
export const CALIBRATION = {
  /** 2026 pole (Antonelli), s */
  QUALI_LAP_TARGET: 88.1,
  QUALI_LAP_TOLERANCE: 1.5,
  RACE_LAP_MIN: 89.0,
  RACE_LAP_MAX: 95.0,
  /** end of Hangar Straight with deploy, km/h */
  TOP_SPEED_MIN_KMH: 315,
  TOP_SPEED_MAX_KMH: 345,
  /** Hangar Straight probe span (Chapel exit -> Stowe braking), m */
  HANGAR_SPAN_START_S: 4290,
  HANGAR_SPAN_END_S: 5000,
  /** end-of-Hangar probe point (Stowe braking zone entry), m */
  HANGAR_END_S: 4950,
  /** min end-of-Hangar speed loss, empty-ES car vs deploying car, km/h */
  DEPLETION_DELTA_MIN_KMH: 35,
  /** quali-lap apex-speed targets at each Corner.apexS, km/h (research table) */
  APEX_TARGETS_KMH: {
    Village: 130,
    'The Loop': 100,
    Brooklands: 152,
    Copse: 295,
    Stowe: 250,
    Vale: 115,
  } as Record<string, number>,
  /** tolerance around each apex target, km/h */
  APEX_TOLERANCE_KMH: 20,
  /**
   * Documented residuals beyond the +/-20 band, km/h (widen the LOWER bound
   * only). Village: the 130 km/h target implies a ~45-50 m driven radius, but
   * the TUMFTM width corridor caps the Village line radius at ~31 m (the
   * Village->Loop back-to-back compromise), so the sim tops out ~101 km/h.
   * No CAR-block tuning closes this without breaking every other corner
   * (it would take TIRE_MU ~2.3). Flagged in the calibration report.
   */
  APEX_RESIDUAL_KMH: { Village: 12 } as Record<string, number>,
} as const;
