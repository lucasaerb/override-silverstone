/**
 * Racing line: lateral offset from the centerline per track sample, staying
 * inside the real track-width corridor. The TUMFTM data is a CENTERLINE, whose
 * corner radii are 1.5-3x tighter than the driven line (centerline Copse is
 * R=57 m; the real line supports ~295 km/h) — so corner speed limits and car
 * paths must come from this module's curvature, not the raw centerline's.
 *
 * Rendering/physics contract: a car's world position is
 *   centerline(s) + (racingLine.offset[i] + car.lateralOffset) * normal(s)
 * where car.lateralOffset is the dynamic overtaking delta only.
 *
 * Method: minimum-curvature line in road coordinates (the TUMFTM min-curvature
 * QP linearization). With a(s) the lateral offset and kappa_c(s) the centerline
 * curvature, the path curvature is approximated as
 *   kappa_path ~= kappa_c + kappa_c^2 a + a''          (a'' w.r.t. centerline s)
 * (first-order in kappa_c*a; exact for straights and for constant offsets on
 * arcs). Minimizing E = sum kappa_path^2 over the corridor is a convex QP in a.
 * IMPORTANT: the naive alternative — minimizing world-space second differences
 * |P[i-1]-2P[i]+P[i+1]|^2 — is wrong here: that quantity scales with (path
 * sample spacing)^2, which SHRINKS on the inside of hairpins, so it rewards
 * tight inside lines instead of open ones.
 *
 * Solver: projected coordinate descent (SOR, exact 1-D Newton step per sample,
 * clamped to the corridor), swept coarse-to-fine over strides 16 -> 4 -> 1 so
 * the long-wavelength out-in-out modes of fast corners converge (plain
 * Gauss-Seidel on this biharmonic-like operator would need ~100x the sweeps).
 * Alternating sweep direction keeps the result symmetric around the loop.
 * Fully deterministic — fixed sweep counts, no RNG; ~100 ms at 2,944 samples
 * (test budget is 10 s).
 *
 * The returned kappa is recomputed from the FINAL offset path in world space
 * by the same finite-difference turn-angle formula + moving-average smoothing
 * track.ts uses for the centerline, so downstream consumers (computeVLimit)
 * see curvature with identical conventions.
 */
import type { TrackData } from './types';

export interface RacingLine {
  /** lateral offset from centerline per track sample, m; positive = left */
  offset: Float32Array;
  /** signed curvature of the offset path per sample, 1/m */
  kappa: Float32Array;
}

/**
 * Corridor safety margin, m: car half-width (~1.0) + 0.5 line-keeping safety.
 * The TUMFTM widths are conservative racing-surface bounds (kerbs excluded),
 * so this stays deliberately lean. Calibration tunable.
 */
export const MARGIN = 1.5;

/** coarse-to-fine schedule: [sample stride, SOR sweeps] per level */
const LEVELS: ReadonlyArray<readonly [number, number]> = [
  [16, 4000],
  [4, 2500],
  [1, 2000],
] as const;
/** SOR over-relaxation factor (1 = plain Gauss-Seidel; < 2 for stability) */
const OMEGA = 1.6;
/** moving-average half-width for the path kappa — same style as track.ts */
const KAPPA_SMOOTH_HALF = 5;

/**
 * Projected-SOR sweeps of E = sum kappa_lin^2 over the subsequence idx of
 * samples (stride h meters apart), updating `a` in place. kappa_lin_j =
 * k_j + c_j a_j + (a_{j-1} - 2 a_j + a_{j+1}) / h^2 on the subsequence, kept
 * incrementally: each accepted offset change updates the three affected
 * kappa_lin entries in O(1).
 */
function relaxLevel(
  a: Float64Array,
  k: Float64Array,
  c: Float64Array,
  lo: Float64Array,
  hi: Float64Array,
  stride: number,
  h: number,
  sweeps: number,
): void {
  const n = a.length;
  const m = Math.ceil(n / stride);
  const u = 1 / (h * h);
  const av = new Float64Array(m);
  const cv = new Float64Array(m);
  const lov = new Float64Array(m);
  const hiv = new Float64Array(m);
  const kl = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    const i = j * stride;
    av[j] = a[i];
    cv[j] = c[i];
    lov[j] = lo[i];
    hiv[j] = hi[i];
    kl[j] = k[i];
  }
  for (let j = 0; j < m; j++) {
    const jm = j >= 1 ? j - 1 : m - 1;
    const jp = j + 1 < m ? j + 1 : 0;
    kl[j] += cv[j] * av[j] + u * (av[jm] - 2 * av[j] + av[jp]);
  }
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const backward = (sweep & 1) === 1;
    for (let step = 0; step < m; step++) {
      const j = backward ? m - 1 - step : step;
      const jm = j >= 1 ? j - 1 : m - 1;
      const jp = j + 1 < m ? j + 1 : 0;
      const d = cv[j] - 2 * u;
      // dE/da_j = 2 (kl_j d + (kl_{j-1} + kl_{j+1}) u); d2E/da_j^2 = 2 (d^2 + 2u^2)
      const g = kl[j] * d + (kl[jm] + kl[jp]) * u;
      let na = av[j] - (OMEGA * g) / (d * d + 2 * u * u);
      if (na > hiv[j]) na = hiv[j];
      else if (na < lov[j]) na = lov[j];
      const da = na - av[j];
      if (da !== 0) {
        av[j] = na;
        kl[j] += d * da;
        kl[jm] += u * da;
        kl[jp] += u * da;
      }
    }
  }
  for (let j = 0; j < m; j++) a[j * stride] = av[j];
  if (stride > 1) {
    // linear interpolation between coarse nodes, clamped to the corridor
    for (let j = 0; j < m; j++) {
      const i0 = j * stride;
      const i1 = ((j + 1) % m) * stride;
      const gap = ((i1 - i0 + n) % n) || n;
      for (let o = 1; o < gap; o++) {
        const i = (i0 + o) % n;
        let v = a[i0] + ((a[i1] - a[i0]) * o) / gap;
        if (v > hi[i]) v = hi[i];
        else if (v < lo[i]) v = lo[i];
        a[i] = v;
      }
    }
  }
}

export function computeRacingLine(track: TrackData): RacingLine {
  const n = track.samples.length;
  const k = new Float64Array(n);
  const c = new Float64Array(n);
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const smp = track.samples[i];
    k[i] = smp.kappa;
    c[i] = smp.kappa * smp.kappa;
    hi[i] = Math.max(0, smp.wLeft - MARGIN);
    lo[i] = -Math.max(0, smp.wRight - MARGIN);
  }

  const a = new Float64Array(n);
  for (const [stride, sweeps] of LEVELS) {
    relaxLevel(a, k, c, lo, hi, stride, track.ds * stride, sweeps);
  }

  // ---- exact curvature of the world-space offset path (track.ts conventions)
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const smp = track.samples[i];
    px[i] = smp.x + a[i] * smp.nx;
    py[i] = smp.y + a[i] * smp.ny;
  }
  const kappaRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const im = i >= 1 ? i - 1 : n - 1;
    const ip = i + 1 < n ? i + 1 : 0;
    const ax = px[i] - px[im];
    const ay = py[i] - py[im];
    const bx = px[ip] - px[i];
    const by = py[ip] - py[i];
    const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    kappaRaw[i] = (2 * turn) / (Math.hypot(ax, ay) + Math.hypot(bx, by));
  }
  const offset = new Float32Array(n);
  const kappa = new Float32Array(n);
  const window = 2 * KAPPA_SMOOTH_HALF + 1;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let o = -KAPPA_SMOOTH_HALF; o <= KAPPA_SMOOTH_HALF; o++) {
      sum += kappaRaw[(i + o + n) % n];
    }
    kappa[i] = sum / window;
    offset[i] = a[i];
  }
  return { offset, kappa };
}
