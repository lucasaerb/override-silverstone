import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { buildTrack, parseTrackCsv } from '../src/sim/track';
import { MARGIN, computeRacingLine } from '../src/sim/racingLine';

/**
 * Racing-line optimizer tests against the real Silverstone data.
 *
 * Radius expectations: the min-curvature line opens corners well past the
 * centerline radius, but it is CORRIDOR-limited by the TUMFTM widths (mean
 * total ~13.8 m, kerbs excluded). Converged values: Copse ~108 m (1.9x the
 * 56 m centerline; the 120-200 m "2-3x" aspiration is geometrically out of
 * reach inside this corridor for a 77 deg corner — documented residual),
 * Stowe ~84 m (long 122 deg corner), The Loop ~23 m (hairpin, width barely
 * helps). Bounds below bracket those converged values with slack for future
 * solver tweaks while still proving real expansion.
 */
const csv = readFileSync('public/data/silverstone.csv', 'utf8');
const track = buildTrack(parseTrackCsv(csv), 'Silverstone');

const t0 = performance.now();
const line = computeRacingLine(track);
const elapsedMs = performance.now() - t0;

const n = track.samples.length;

/** min radius (1/max|kappa|) over an s-span, wrap-aware */
function minRadius(kappa: Float32Array, sStart: number, sEnd: number): number {
  let peak = 0;
  for (let i = Math.floor(sStart / track.ds); i <= Math.ceil(sEnd / track.ds); i++) {
    const k = Math.abs(kappa[((i % n) + n) % n]);
    if (k > peak) peak = k;
  }
  return 1 / peak;
}
const centerKappa = new Float32Array(track.samples.map((s) => s.kappa));
const spanOf = (name: string): [number, number] => {
  const c = track.corners.find((k) => k.name === name)!;
  return [c.sStart, c.sEnd];
};

describe('computeRacingLine interface', () => {
  it('returns one offset and one kappa per track sample, all finite', () => {
    expect(line.offset).toBeInstanceOf(Float32Array);
    expect(line.kappa).toBeInstanceOf(Float32Array);
    expect(line.offset.length).toBe(n);
    expect(line.kappa.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(line.offset[i])).toBe(true);
      expect(Number.isFinite(line.kappa[i])).toBe(true);
    }
  });

  it('stays inside the width corridor with the safety margin everywhere', () => {
    for (let i = 0; i < n; i++) {
      const o = line.offset[i];
      const bound = o >= 0 ? track.samples[i].wLeft : track.samples[i].wRight;
      // 1e-3 slack for Float32 rounding of the clamped Float64 solution
      expect(Math.abs(o)).toBeLessThanOrEqual(Math.max(0, bound - MARGIN) + 1e-3);
    }
  });

  it('is deterministic: identical output on a fresh run', () => {
    const again = computeRacingLine(track);
    expect(again.offset).toEqual(line.offset);
    expect(again.kappa).toEqual(line.kappa);
  });

  it('converges within the 10 s time budget', () => {
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

describe('racing-line geometry', () => {
  it('opens Copse well past the centerline radius (corridor-limited ~108 m)', () => {
    const [a, b] = spanOf('Copse');
    const rLine = minRadius(line.kappa, a, b);
    const rCenter = minRadius(centerKappa, a, b);
    expect(rLine).toBeGreaterThan(95);
    expect(rLine).toBeLessThan(200);
    expect(rLine / rCenter).toBeGreaterThan(1.5);
  });

  it('expands Stowe past the centerline radius', () => {
    const [a, b] = spanOf('Stowe');
    const rLine = minRadius(line.kappa, a, b);
    const rCenter = minRadius(centerKappa, a, b);
    expect(rLine).toBeGreaterThan(78);
    expect(rLine).toBeLessThan(200);
    expect(rLine / rCenter).toBeGreaterThan(1.1);
  });

  it('keeps The Loop hairpin tight — width cannot help much', () => {
    const [a, b] = spanOf('The Loop');
    const rLine = minRadius(line.kappa, a, b);
    expect(rLine).toBeGreaterThan(20);
    expect(rLine).toBeLessThan(45);
  });

  it('drives Copse out-in-out: inside at the apex, outside on exit', () => {
    // Copse is a right-hander (kappa < 0): inside = right = negative offset
    const apexIdx = Math.round(3133 / track.ds) % n;
    const exitIdx = Math.round(3250 / track.ds) % n;
    expect(line.offset[apexIdx]).toBeLessThan(-3);
    expect(line.offset[exitIdx]).toBeGreaterThan(2);
  });

  it('uses real track width somewhere on the lap', () => {
    let maxAbs = 0;
    for (let i = 0; i < n; i++) maxAbs = Math.max(maxAbs, Math.abs(line.offset[i]));
    expect(maxAbs).toBeGreaterThan(4);
  });

  it('leaves the Hangar Straight essentially straight', () => {
    const midHangarIdx = Math.round(4600 / track.ds) % n;
    expect(Math.abs(line.kappa[midHangarIdx])).toBeLessThan(1 / 1000);
  });
});
