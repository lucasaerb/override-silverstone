/**
 * Test-only synthetic tracks with analytically exact geometry, so the
 * physics/energy/override suites never depend on the real Silverstone data
 * module. Two shapes:
 *  - 'stadium': two straights of length L joined by two constant-radius-R
 *    semicircles, driven counter-clockwise (kappa = +1/R in the arcs);
 *  - 'circle': one constant-radius loop (kappa = +1/R everywhere) — with a
 *    large R its vLimit is uncapped, giving an endless straight for
 *    top-speed / taper tests.
 * ds is adjusted so the lap divides evenly and samples[i].s === i * ds holds
 * exactly, per the TrackData contract.
 */
import type { CarState, Corner, TrackData, TrackSample, TrackZone } from '../src/sim/types';
import { PU } from '../src/sim/constants';

export interface SyntheticSpec {
  kind: 'stadium' | 'circle';
  /** stadium straight length L, m (default 700) */
  straight?: number;
  /** corner / loop radius R, m (default 60 stadium, 3000 circle) */
  radius?: number;
  /** target sample spacing, m (default 2; adjusted to divide the lap evenly) */
  ds?: number;
  /** mark every zone as a 350 kW acceleration zone (default true) */
  accelZones?: boolean;
  /** X-mode spans on the straights (stadium) / whole lap (circle); default true */
  xMode?: boolean;
  detectionLineS?: number;
  activationLineS?: number;
}

function arcSample(
  cx: number,
  cy: number,
  r: number,
  phi0: number,
  sArc: number,
): Omit<TrackSample, 's' | 'wLeft' | 'wRight'> {
  const phi = phi0 + sArc / r;
  return {
    x: cx + r * Math.cos(phi),
    y: cy + r * Math.sin(phi),
    tx: -Math.sin(phi),
    ty: Math.cos(phi),
    nx: -Math.cos(phi),
    ny: -Math.sin(phi),
    kappa: 1 / r,
  };
}

export function makeSyntheticTrack(spec: SyntheticSpec): TrackData {
  const stadium = spec.kind === 'stadium';
  const L = spec.straight ?? 700;
  const R = spec.radius ?? (stadium ? 60 : 3000);
  const piR = Math.PI * R;
  const length = stadium ? 2 * L + 2 * piR : 2 * piR;
  const n = Math.max(16, Math.round(length / (spec.ds ?? 2)));
  const ds = length / n;

  const samples: TrackSample[] = [];
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    let g: Omit<TrackSample, 's' | 'wLeft' | 'wRight'>;
    if (!stadium) {
      g = arcSample(0, R, R, -Math.PI / 2, s);
    } else if (s < L) {
      g = { x: s, y: 0, tx: 1, ty: 0, nx: 0, ny: 1, kappa: 0 };
    } else if (s < L + piR) {
      g = arcSample(L, R, R, -Math.PI / 2, s - L);
    } else if (s < 2 * L + piR) {
      g = { x: L - (s - L - piR), y: 2 * R, tx: -1, ty: 0, nx: 0, ny: -1, kappa: 0 };
    } else {
      g = arcSample(0, R, R, Math.PI / 2, s - 2 * L - piR);
    }
    samples.push({ s, ...g, wLeft: 6, wRight: 6 });
  }

  const accel = spec.accelZones ?? true;
  const zone = (id: number, name: string, sStart: number, sEnd: number, kind: TrackZone['kind']) =>
    ({ id, name, sStart, sEnd, kind, accelZone: accel }) satisfies TrackZone;
  const zones: TrackZone[] = stadium
    ? [
        zone(0, 'straight-1', 0, L, 'straight'),
        zone(1, 'corner-1', L, L + piR, 'corner'),
        zone(2, 'straight-2', L + piR, 2 * L + piR, 'straight'),
        zone(3, 'corner-2', 2 * L + piR, length, 'corner'),
      ]
    : [zone(0, 'half-1', 0, length / 2, 'straight'), zone(1, 'half-2', length / 2, length, 'straight')];
  const corners: Corner[] = stadium
    ? [
        { id: 1, name: 'Corner 1', apexS: L + piR / 2, sStart: L, sEnd: L + piR, minRadius: R, dir: 'L' },
        { id: 2, name: 'Corner 2', apexS: 2 * L + 1.5 * piR, sStart: 2 * L + piR, sEnd: length, minRadius: R, dir: 'L' },
      ]
    : [];
  const xMode = spec.xMode ?? true;
  const straightModeZones = !xMode
    ? []
    : stadium
      ? [
          { sStart: 0, sEnd: L },
          { sStart: L + piR, sEnd: 2 * L + piR },
        ]
      : [{ sStart: 0, sEnd: length }];

  return {
    name: `synthetic-${spec.kind}`,
    length,
    samples,
    ds,
    corners,
    zones,
    straightModeZones,
    detectionLineS: spec.detectionLineS ?? (stadium ? 2 * L + 1.5 * piR : 0.75 * length),
    activationLineS: spec.activationLineS ?? (stadium ? 15 : 0.05 * length),
    sector2S: length / 3,
    sector3S: (2 * length) / 3,
  };
}

/** fresh CarState with a full battery and a uniform deploy/lift map */
export function makeCar(
  id: 'player' | 'rival',
  track: TrackData,
  patch: Partial<CarState> = {},
): CarState {
  return {
    id,
    s: 0,
    lap: 0,
    v: 0,
    lateralOffset: 0,
    energy: {
      soc: PU.ES_WINDOW,
      harvestedThisLap: 0,
      deployedThisLap: 0,
      overrideArmed: false,
      overrideActive: false,
      overrideBonusRemaining: 0,
      lastDeployPowerW: 0,
    },
    deployMap: {
      zoneDeploy: track.zones.map(() => 1),
      zoneLift: track.zones.map(() => 0),
    },
    inputs: { boostHeld: false, aggressiveness: 1 },
    aeroMode: 'Z',
    inTow: false,
    gear: 1,
    throttle: 0,
    brake: 0,
    deployPowerW: 0,
    totalTime: 0,
    currentLapTime: 0,
    lapTimes: [],
    currentSectors: [],
    bestLap: null,
    finished: false,
    finishTime: null,
    ...patch,
  };
}
