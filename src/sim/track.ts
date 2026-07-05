/**
 * Silverstone track pipeline: TUMFTM centerline CSV -> closed centripetal
 * Catmull-Rom spline -> uniform arc-length samples (position / tangent /
 * left normal / signed curvature / widths) -> corner + zone metadata.
 *
 * Geometry source: public/data/silverstone.csv (TUMFTM racetrack-database,
 * 1,178 points, ~5 m spacing, closed loop; dataset start == the current
 * start/finish line on the Hamilton Straight). Measured length 5,886.8 m vs
 * 5,891 m official. See research/silverstone.md for provenance.
 *
 * Conventions (per src/sim/types.ts):
 *  - samples[i].s === i * ds exactly; ds = length / round(length / 2) ≈ 2 m.
 *  - normal is the unit LEFT normal, 90° CCW from the tangent: n = (-ty, tx).
 *  - kappa is signed CENTERLINE curvature, positive = left turn. The driven
 *    racing-line radius is typically 1.5-3x the centerline radius — corner
 *    speed models must account for that, not this module.
 *  - straightModeZones spans with sStart > sEnd wrap through the start/finish
 *    line (only the pit-straight zone does; wrapping is resolved by sInSpan
 *    -style checks in consumers: s in span iff s >= sStart OR s < sEnd).
 *
 * No three.js imports — the sim layer runs headless under Vitest.
 */

import type { Corner, TrackData, TrackPose, TrackSample, TrackZone } from './types';

export interface TrackSourcePoint {
  x: number;
  y: number;
  wRight: number;
  wLeft: number;
}

/** target uniform sample spacing, m */
const DS_TARGET = 2;
/** spline sub-samples per source segment for the arc-length table (~0.5 m) */
const DENSE_SUBDIVISIONS = 10;
/**
 * Moving-average half-width for kappa, in samples (11 samples ≈ 22 m).
 * Calibrated so apex radii match the research-derived centerline values:
 * Loop ≈ 17 m, Village ≈ 25 m, Brooklands ≈ 41 m, Stowe ≈ 72 m.
 */
const KAPPA_SMOOTH_HALF = 5;

// ---------------------------------------------------------------- parsing

/**
 * Parses the TUMFTM track CSV (header `# x_m,y_m,w_tr_right_m,w_tr_left_m`).
 * Column order is width-RIGHT then width-LEFT. The dataset does not repeat
 * the first point at the end (last->first gap is a normal ~5 m segment), but
 * a duplicated closing point is dropped defensively if present.
 */
export function parseTrackCsv(csvText: string): TrackSourcePoint[] {
  const points: TrackSourcePoint[] = [];
  for (const line of csvText.split('\n')) {
    const row = line.trim();
    if (row === '' || row.startsWith('#')) continue;
    const cols = row.split(',').map(Number);
    if (cols.length !== 4 || cols.some((v) => !Number.isFinite(v))) {
      throw new Error(`track csv: malformed row "${row}"`);
    }
    points.push({ x: cols[0], y: cols[1], wRight: cols[2], wLeft: cols[3] });
  }
  if (points.length < 4) throw new Error('track csv: need at least 4 points');
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-3) points.pop();
  return points;
}

// ---------------------------------------------------------------- spline

/**
 * Centripetal Catmull-Rom (alpha = 0.5) evaluated between p1 and p2 via the
 * Barry-Goldman pyramid, u in [0, 1). Centripetal knots avoid the cusps and
 * loops uniform CR can produce where source spacing varies through corners.
 */
function catmullRom(
  p0: TrackSourcePoint,
  p1: TrackSourcePoint,
  p2: TrackSourcePoint,
  p3: TrackSourcePoint,
  u: number,
): [number, number] {
  const knot = (a: TrackSourcePoint, b: TrackSourcePoint) =>
    Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-4);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + u * (t2 - t1);
  const lerp = (
    ax: number, ay: number, bx: number, by: number, ta: number, tb: number,
  ): [number, number] => {
    const w = (t - ta) / (tb - ta);
    return [ax + (bx - ax) * w, ay + (by - ay) * w];
  };
  const [a1x, a1y] = lerp(p0.x, p0.y, p1.x, p1.y, 0, t1);
  const [a2x, a2y] = lerp(p1.x, p1.y, p2.x, p2.y, t1, t2);
  const [a3x, a3y] = lerp(p2.x, p2.y, p3.x, p3.y, t2, t3);
  const [b1x, b1y] = lerp(a1x, a1y, a2x, a2y, 0, t2);
  const [b2x, b2y] = lerp(a2x, a2y, a3x, a3y, t1, t3);
  return lerp(b1x, b1y, b2x, b2y, t1, t2);
}

// ---------------------------------------------------------------- metadata

/** T1-T18 from research/track-data/silverstone_corners_derived.csv [C]. */
const CORNER_SPECS: ReadonlyArray<Omit<Corner, 'minRadius'>> = [
  { id: 1, name: 'Abbey', apexS: 395, sStart: 375, sEnd: 465, dir: 'R' },
  { id: 2, name: 'Farm', apexS: 645, sStart: 565, sEnd: 710, dir: 'L' },
  { id: 3, name: 'Village', apexS: 894, sStart: 850, sEnd: 935, dir: 'R' },
  { id: 4, name: 'The Loop', apexS: 1044, sStart: 1000, sEnd: 1150, dir: 'L' },
  { id: 5, name: 'Aintree', apexS: 1230, sStart: 1150, sEnd: 1294, dir: 'L' },
  { id: 6, name: 'Brooklands', apexS: 2004, sStart: 1889, sEnd: 2049, dir: 'L' },
  { id: 7, name: 'Luffield', apexS: 2179, sStart: 2074, sEnd: 2309, dir: 'R' },
  { id: 8, name: 'Woodcote', apexS: 2500, sStart: 2414, sEnd: 2628, dir: 'R' },
  { id: 9, name: 'Copse', apexS: 3133, sStart: 3008, sEnd: 3183, dir: 'R' },
  { id: 10, name: 'Maggotts', apexS: 3613, sStart: 3568, sEnd: 3673, dir: 'L' },
  { id: 11, name: 'Becketts 1', apexS: 3713, sStart: 3683, sEnd: 3758, dir: 'R' },
  { id: 12, name: 'Becketts 2', apexS: 3888, sStart: 3808, sEnd: 3943, dir: 'L' },
  { id: 13, name: 'Becketts 3', apexS: 4018, sStart: 3953, sEnd: 4133, dir: 'R' },
  { id: 14, name: 'Chapel', apexS: 4193, sStart: 4148, sEnd: 4228, dir: 'L' },
  { id: 15, name: 'Stowe', apexS: 5083, sStart: 4953, sEnd: 5162, dir: 'R' },
  { id: 16, name: 'Vale', apexS: 5517, sStart: 5487, sEnd: 5547, dir: 'L' },
  { id: 17, name: 'Club', apexS: 5597, sStart: 5557, sEnd: 5680, dir: 'R' },
  { id: 18, name: 'Club Exit', apexS: 5720, sStart: 5680, sEnd: 5807, dir: 'R' },
] as const;

/**
 * Player-facing deploy zones. Boundaries follow braking points / corner spans
 * (e.g. Wellington ends at the ~1,880 m Brooklands braking point, Hangar at
 * the ~5,000 m Stowe braking point). The last zone's sEnd is set to the
 * computed track length so the zones tile [0, length) exactly.
 * accelZone: corner-exit -> next-braking-point spans (straights + flat-out
 * sweeps); false for braking / slow-corner / lift-harvest zones.
 */
const ZONE_SPECS: ReadonlyArray<{
  name: string;
  sStart: number;
  kind: TrackZone['kind'];
  accelZone: boolean;
}> = [
  { name: 'Pit Straight', sStart: 0, kind: 'straight', accelZone: true },
  { name: 'Abbey–Farm', sStart: 340, kind: 'complex', accelZone: true },
  { name: 'Village Brake', sStart: 780, kind: 'corner', accelZone: false },
  { name: 'The Loop', sStart: 1000, kind: 'corner', accelZone: false },
  { name: 'Aintree Exit', sStart: 1150, kind: 'corner', accelZone: true },
  { name: 'Wellington Straight', sStart: 1294, kind: 'straight', accelZone: true },
  { name: 'Brooklands', sStart: 1880, kind: 'corner', accelZone: false },
  { name: 'Luffield', sStart: 2074, kind: 'corner', accelZone: false },
  { name: 'Woodcote', sStart: 2350, kind: 'corner', accelZone: true },
  { name: 'National Straight', sStart: 2628, kind: 'straight', accelZone: true },
  { name: 'Copse', sStart: 3060, kind: 'corner', accelZone: true },
  { name: 'Maggotts', sStart: 3300, kind: 'complex', accelZone: true },
  { name: 'Becketts', sStart: 3683, kind: 'complex', accelZone: false },
  { name: 'Chapel Exit', sStart: 4148, kind: 'corner', accelZone: true },
  { name: 'Hangar Straight', sStart: 4290, kind: 'straight', accelZone: true },
  { name: 'Stowe', sStart: 5000, kind: 'corner', accelZone: false },
  { name: 'Vale Brake', sStart: 5330, kind: 'corner', accelZone: false },
  { name: 'Club', sStart: 5560, kind: 'corner', accelZone: true },
  { name: 'Club Exit', sStart: 5730, kind: 'straight', accelZone: true },
] as const;

/** 2026 active-aero X-mode spans; the pit-straight zone wraps through S/F. */
const STRAIGHT_MODE_ZONES: ReadonlyArray<{ sStart: number; sEnd: number }> = [
  { sStart: 5807, sEnd: 340 },
  { sStart: 1250, sEnd: 1890 },
  { sStart: 2560, sEnd: 3060 },
  { sStart: 4230, sEnd: 4950 },
] as const;

/** Manual Override lines: detection after T17 Club apex, activation at exit. */
const DETECTION_LINE_S = 5600;
const ACTIVATION_LINE_S = 5850;
const SECTOR2_S = 1780;
const SECTOR3_S = 4900;

// ---------------------------------------------------------------- build

/**
 * Builds the full TrackData from parsed source points: dense spline
 * pre-sampling for the arc-length table, uniform ds ≈ 2 m resampling,
 * finite-difference tangents and smoothed signed curvature, then the
 * hardcoded Silverstone metadata with per-corner minRadius measured from
 * the computed kappa over each corner span.
 */
export function buildTrack(points: TrackSourcePoint[], name: string): TrackData {
  const n = points.length;

  const dense: { x: number; y: number; wLeft: number; wRight: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let j = 0; j < DENSE_SUBDIVISIONS; j++) {
      const u = j / DENSE_SUBDIVISIONS;
      const [x, y] = catmullRom(p0, p1, p2, p3, u);
      dense.push({
        x,
        y,
        wLeft: p1.wLeft + (p2.wLeft - p1.wLeft) * u,
        wRight: p1.wRight + (p2.wRight - p1.wRight) * u,
      });
    }
  }
  const m = dense.length;
  const cum = new Float64Array(m + 1);
  for (let i = 1; i <= m; i++) {
    const a = dense[i - 1];
    const b = dense[i % m];
    cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const length = cum[m];

  const count = Math.round(length / DS_TARGET);
  const ds = length / count;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const wLefts = new Float64Array(count);
  const wRights = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const s = i * ds;
    while (cum[j + 1] < s) j++;
    const f = (s - cum[j]) / (cum[j + 1] - cum[j]);
    const a = dense[j];
    const b = dense[(j + 1) % m];
    xs[i] = a.x + (b.x - a.x) * f;
    ys[i] = a.y + (b.y - a.y) * f;
    wLefts[i] = a.wLeft + (b.wLeft - a.wLeft) * f;
    wRights[i] = a.wRight + (b.wRight - a.wRight) * f;
  }

  const txs = new Float64Array(count);
  const tys = new Float64Array(count);
  const kappaRaw = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const ip = (i - 1 + count) % count;
    const inx = (i + 1) % count;
    const dx = xs[inx] - xs[ip];
    const dy = ys[inx] - ys[ip];
    const dl = Math.hypot(dx, dy);
    txs[i] = dx / dl;
    tys[i] = dy / dl;
    const ax = xs[i] - xs[ip];
    const ay = ys[i] - ys[ip];
    const bx = xs[inx] - xs[i];
    const by = ys[inx] - ys[i];
    const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    kappaRaw[i] = (2 * turn) / (Math.hypot(ax, ay) + Math.hypot(bx, by));
  }

  const kappa = new Float64Array(count);
  const window = 2 * KAPPA_SMOOTH_HALF + 1;
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let o = -KAPPA_SMOOTH_HALF; o <= KAPPA_SMOOTH_HALF; o++) {
      sum += kappaRaw[(i + o + count) % count];
    }
    kappa[i] = sum / window;
  }

  const samples: TrackSample[] = new Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = {
      s: i * ds,
      x: xs[i],
      y: ys[i],
      tx: txs[i],
      ty: tys[i],
      nx: -tys[i],
      ny: txs[i],
      kappa: kappa[i],
      wLeft: wLefts[i],
      wRight: wRights[i],
    };
  }

  const peakKappaIn = (sStart: number, sEnd: number): number => {
    const lo = Math.floor(sStart / ds);
    const hi = Math.ceil(sEnd / ds);
    let peak = 0;
    for (let i = lo; i <= hi; i++) {
      const k = Math.abs(kappa[((i % count) + count) % count]);
      if (k > peak) peak = k;
    }
    return peak;
  };
  const corners: Corner[] = CORNER_SPECS.map((c) => ({
    ...c,
    minRadius: 1 / peakKappaIn(c.sStart, c.sEnd),
  }));

  const zones: TrackZone[] = ZONE_SPECS.map((z, i) => ({
    id: i,
    name: z.name,
    sStart: z.sStart,
    sEnd: i + 1 < ZONE_SPECS.length ? ZONE_SPECS[i + 1].sStart : length,
    kind: z.kind,
    accelZone: z.accelZone,
  }));

  return {
    name,
    length,
    samples,
    ds,
    corners,
    zones,
    straightModeZones: STRAIGHT_MODE_ZONES.map((z) => ({ ...z })),
    detectionLineS: DETECTION_LINE_S,
    activationLineS: ACTIVATION_LINE_S,
    sector2S: SECTOR2_S,
    sector3S: SECTOR3_S,
  };
}

// ---------------------------------------------------------------- queries

/** Wraps an arbitrary s into [0, track.length). */
export function wrapS(track: TrackData, s: number): number {
  const L = track.length;
  const w = ((s % L) + L) % L;
  return w === L ? 0 : w;
}

/**
 * Signed shortest along-track distance from b to a, in (-L/2, L/2]:
 * positive = a is ahead of b. Use for gap computation across the S/F line.
 */
export function sDelta(track: TrackData, a: number, b: number): number {
  const L = track.length;
  const d = wrapS(track, a - b);
  return d > L / 2 ? d - L : d;
}

/**
 * O(1) interpolated pose at arbitrary s (wrapped into [0, length)). Linear
 * interpolation between the two surrounding samples; tangent/normal are
 * re-normalized after the lerp.
 */
export function trackAt(track: TrackData, s: number): TrackPose {
  const { samples, ds } = track;
  const count = samples.length;
  const sw = wrapS(track, s);
  const i0 = Math.min(Math.floor(sw / ds), count - 1);
  const i1 = (i0 + 1) % count;
  const f = sw / ds - i0;
  const a = samples[i0];
  const b = samples[i1];
  let tx = a.tx + (b.tx - a.tx) * f;
  let ty = a.ty + (b.ty - a.ty) * f;
  const tl = Math.hypot(tx, ty);
  tx /= tl;
  ty /= tl;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    tx,
    ty,
    nx: -ty,
    ny: tx,
    kappa: a.kappa + (b.kappa - a.kappa) * f,
    wLeft: a.wLeft + (b.wLeft - a.wLeft) * f,
    wRight: a.wRight + (b.wRight - a.wRight) * f,
  };
}

// ---------------------------------------------------------------- loading

/** Browser entry point; tests use parseTrackCsv/buildTrack with fs instead. */
export async function loadTrack(): Promise<TrackData> {
  const res = await fetch('/data/silverstone.csv');
  if (!res.ok) throw new Error(`loadTrack: ${res.status} ${res.statusText}`);
  return buildTrack(parseTrackCsv(await res.text()), 'Silverstone');
}
