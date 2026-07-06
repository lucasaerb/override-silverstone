/**
 * Shared contracts for the whole game. Every module (sim, render, ui) builds
 * against these types. The sim layer must never import from three.js — it runs
 * headless under Vitest and in the browser identically.
 *
 * Coordinate conventions:
 *  - Track plane is x/y in meters (TUMFTM data plane). Render maps (x, y) -> (x, -z) in Three.
 *  - `s` is arc length along the centerline from the start/finish line, in meters,
 *    always in [0, track.length). Speeds are m/s internally; km/h only at UI/regulation
 *    boundaries (the FIA taper formulas are written in km/h).
 *  - Energy in Joules internally; MJ only in UI.
 */

// ---------------------------------------------------------------- track

export interface TrackSample {
  s: number;
  x: number;
  y: number;
  /** unit tangent */
  tx: number;
  ty: number;
  /** unit left normal (90° CCW from tangent) */
  nx: number;
  ny: number;
  /** signed curvature, 1/m; positive = turning left */
  kappa: number;
  /** track width to the left / right of centerline, m */
  wLeft: number;
  wRight: number;
}

export interface Corner {
  /** turn number, 1-18 */
  id: number;
  name: string;
  apexS: number;
  /** approximate corner span */
  sStart: number;
  sEnd: number;
  minRadius: number;
  dir: 'L' | 'R';
}

/** One of ~20 player-facing deployment segments the lap is divided into. */
export interface TrackZone {
  id: number;
  name: string;
  sStart: number;
  sEnd: number;
  kind: 'straight' | 'corner' | 'complex';
  /** true if inside a designated 350kW acceleration zone (corner-exit -> braking point) */
  accelZone: boolean;
}

export interface TrackData {
  name: string;
  /** total lap length, m */
  length: number;
  /** uniformly spaced samples, samples[i].s === i * ds */
  samples: TrackSample[];
  ds: number;
  corners: Corner[];
  zones: TrackZone[];
  /** active-aero X-mode (low drag) spans — the 4 real Silverstone straight-mode zones */
  straightModeZones: Array<{ sStart: number; sEnd: number }>;
  /** Manual Override detection line (after T17 Club at Silverstone) */
  detectionLineS: number;
  /** Manual Override activation line (onto pit straight) */
  activationLineS: number;
  /** timing sector boundaries: sector 1 = [0, sector2S), etc. */
  sector2S: number;
  sector3S: number;
}

/** Interpolated pose at an arbitrary s (for placing cars / cameras). */
export interface TrackPose {
  x: number;
  y: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  kappa: number;
  wLeft: number;
  wRight: number;
}

// ---------------------------------------------------------------- energy

export type SessionKind = 'race' | 'quali';

export interface EnergyState {
  /** battery state of charge within the 4 MJ usable window, J (0..ES_WINDOW) */
  soc: number;
  /** MGU-K energy recovered this lap, J (counts against per-lap harvest cap) */
  harvestedThisLap: number;
  deployedThisLap: number;
  /** override armed = earned at detection line, waiting for/holding through activation lap */
  overrideArmed: boolean;
  /** override actually being used right now (armed + boost held) */
  overrideActive: boolean;
  /** remaining J of the +0.5 MJ override harvest bonus for this lap */
  overrideBonusRemaining: number;
  /** last tick's deploy power, W — needed for the 50 kW/s ramp-down clipping rule */
  lastDeployPowerW: number;
}

// ---------------------------------------------------------------- cars

export const DEPLOY_LEVELS = [0, 0.25, 0.5, 0.75, 1] as const;

/** Player/AI strategy: per-zone settings, indexed by TrackZone.id. */
export interface DeployMap {
  /** fraction of available MGU-K power to deploy in each zone, 0..1 */
  zoneDeploy: number[];
  /** lift-and-coast harvesting level per zone, 0..1 (0 = never lift early) */
  zoneLift: number[];
}

export interface CarInputs {
  /** live push-to-pass button (SPACE) */
  boostHeld: boolean;
  /** global deploy trim, multiplies map values; like the real SoC-target rotary. 0.5..1.25 */
  aggressiveness: number;
}

export interface CarState {
  /** 'player' = the local hero; 'rival' the 2-car opponent; 'car2'/'car3' extra
   *  multiplayer entrants. Widened to string for 2-4 car races. */
  id: string;
  /** display name (multiplayer); undefined falls back to a default label */
  name?: string;
  s: number;
  lap: number;
  /** m/s */
  v: number;
  /** signed lateral offset from centerline, m; used for racing line + overtakes */
  lateralOffset: number;
  energy: EnergyState;
  deployMap: DeployMap;
  inputs: CarInputs;
  aeroMode: 'X' | 'Z';
  /** true when inside another car's slipstream */
  inTow: boolean;
  /** display-only */
  gear: number;
  throttle: number;
  brake: number;
  /** live deploy power for HUD, W (negative = harvesting) */
  deployPowerW: number;
  totalTime: number;
  currentLapTime: number;
  lapTimes: number[];
  currentSectors: number[];
  bestLap: number | null;
  finished: boolean;
  /** exact S/F-crossing race time when this car finished, s (null until finished) */
  finishTime: number | null;
}

// ---------------------------------------------------------------- race

export type RacePhase = 'grid' | 'countdown' | 'racing' | 'finished';

export interface RaceEvent {
  tick: number;
  kind:
    | 'race-start'
    | 'lap-complete'
    | 'override-armed'
    | 'override-expired'
    | 'overtake'
    | 'energy-depleted'
    | 'finish';
  carId: string;
  data?: Record<string, number | string>;
}

export interface RaceState {
  tick: number;
  /** sim time, s */
  time: number;
  phase: RacePhase;
  session: SessionKind;
  lapsTotal: number;
  cars: CarState[];
  /** player minus rival: negative = player ahead, in seconds (time gap) */
  gapSeconds: number;
  events: RaceEvent[];
}

// ---------------------------------------------------------------- debug API

/** Exposed as window.__game for Puppeteer / chrome-devtools testing. */
export interface GameDebugApi {
  getState(): RaceState;
  /** advance the sim n ticks synchronously (render decoupled) */
  step(n: number): void;
  /** 0 = paused; 1 = realtime; up to ~50 for fast-forward */
  setTimeScale(scale: number): void;
  setSeed(seed: number): void;
  setDeploy(carId: string, zoneId: number, level: number): void;
  setBoost(held: boolean): void;
  setCamera(name: 'chase' | 'onboard' | 'trackside'): void;
  /** any uncaught errors collected since boot */
  errors: string[];

  // -- flow / strategy control (additive; used by the E2E harness)
  /** current screen: 'menu' | 'strategy' | 'race' | 'result' */
  getScreen(): string;
  /** jump to a screen; 'race' starts a race with the current strategy + settings */
  goto(screen: 'menu' | 'modeselect' | 'strategy' | 'race' | 'result' | 'lobby'): void;
  /** the strategy screen's last lap projection, or null if none computed */
  getProjection(): { lapTime: number; deployedMJ: number } | null;
  /** replace a car's whole deployment map */
  setMap(carId: string, map: DeployMap): void;
  /** current game mode: 'timetrial' | 'optimal' | 'overtake' | 'multiplayer' */
  getMode(): string;
  /** set the game mode (used by the E2E harness before goto) */
  setMode(mode: string): void;
}
