import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { buildTrack, parseTrackCsv, sDelta, trackAt, wrapS } from '../src/sim/track';

/**
 * Track pipeline tests run against the real Silverstone data. Radius bounds
 * are for the CENTERLINE (TUMFTM data): the racing-line radius is 1.5-3x
 * larger (research/silverstone.md §2) — e.g. Copse centerline ≈ 57 m vs a
 * ~150 m driven line, Stowe centerline ≈ 72 m. Bounds bracket the research-
 * derived centerline values, not driven-line radii.
 */
const csv = readFileSync('public/data/silverstone.csv', 'utf8');
const points = parseTrackCsv(csv);
const track = buildTrack(points, 'Silverstone');

const radiusAt = (s: number) => 1 / Math.abs(trackAt(track, s).kappa);
const dist = (s0: number, s1: number) => {
  const a = trackAt(track, s0);
  const b = trackAt(track, s1);
  return Math.hypot(b.x - a.x, b.y - a.y);
};

describe('parseTrackCsv', () => {
  it('parses all 1178 source points with widths in CSV right-then-left order', () => {
    expect(points.length).toBe(1178);
    // first data row: 3.439354,-0.495322,6.556,6.537 -> wRight before wLeft
    expect(points[0].wRight).toBeCloseTo(6.556, 3);
    expect(points[0].wLeft).toBeCloseTo(6.536, 2);
  });

  it('rejects malformed rows', () => {
    expect(() => parseTrackCsv('# h\n1,2,3\n')).toThrow();
    expect(() => parseTrackCsv('# h\n1,2,x,4\n')).toThrow();
  });
});

describe('geometry', () => {
  it('lap length lands within ±20 m of 5,887 m', () => {
    expect(track.length).toBeGreaterThanOrEqual(5867);
    expect(track.length).toBeLessThanOrEqual(5907);
  });

  it('samples are uniform: samples[i].s === i * ds, ds ≈ 2 m', () => {
    expect(track.ds).toBeGreaterThan(1.9);
    expect(track.ds).toBeLessThan(2.1);
    expect(track.samples.length * track.ds).toBeCloseTo(track.length, 9);
    for (let i = 0; i < track.samples.length; i++) {
      if (track.samples[i].s !== i * track.ds) {
        throw new Error(`sample ${i}: s=${track.samples[i].s} !== ${i * track.ds}`);
      }
    }
  });

  it('closes the loop: poses just before/after the S/F line coincide', () => {
    expect(dist(track.length - 0.01, 0.01)).toBeLessThan(3);
  });

  it('tangents and normals are unit length, normal 90° CCW of tangent', () => {
    for (const p of track.samples) {
      expect(Math.hypot(p.tx, p.ty)).toBeCloseTo(1, 9);
      expect(Math.hypot(p.nx, p.ny)).toBeCloseTo(1, 9);
      expect(p.nx).toBeCloseTo(-p.ty, 12);
      expect(p.ny).toBeCloseTo(p.tx, 12);
    }
  });

  it('widths stay within the plausible per-side band [4, 12] m', () => {
    for (const p of track.samples) {
      expect(p.wLeft).toBeGreaterThanOrEqual(4);
      expect(p.wLeft).toBeLessThanOrEqual(12);
      expect(p.wRight).toBeGreaterThanOrEqual(4);
      expect(p.wRight).toBeLessThanOrEqual(12);
    }
  });
});

describe('curvature', () => {
  it('Hangar Straight midpoint is straight (R > 500 m)', () => {
    expect(Math.abs(trackAt(track, 4600).kappa)).toBeLessThan(0.002);
  });

  it('The Loop apex is the tightest point, centerline R ≈ 15-40 m', () => {
    const r = radiusAt(1044);
    expect(r).toBeGreaterThanOrEqual(15);
    expect(r).toBeLessThanOrEqual(40);
  });

  it('Stowe apex centerline R ≈ 55-250 m (research-derived: ~72 m)', () => {
    const r = radiusAt(5083);
    expect(r).toBeGreaterThanOrEqual(55);
    expect(r).toBeLessThanOrEqual(250);
  });

  it('Copse apex centerline R ≈ 40-300 m (research-derived: ~60 m)', () => {
    const r = radiusAt(3133);
    expect(r).toBeGreaterThanOrEqual(40);
    expect(r).toBeLessThanOrEqual(300);
  });

  it('kappa sign matches direction: positive = left turn', () => {
    expect(trackAt(track, 1044).kappa).toBeGreaterThan(0); // The Loop, L
    expect(trackAt(track, 2004).kappa).toBeGreaterThan(0); // Brooklands, L
    expect(trackAt(track, 3133).kappa).toBeLessThan(0); // Copse, R
    expect(trackAt(track, 2179).kappa).toBeLessThan(0); // Luffield, R
  });
});

describe('corners', () => {
  it('has all 18 turns with strictly increasing apexS inside their spans', () => {
    expect(track.corners.length).toBe(18);
    for (let i = 0; i < track.corners.length; i++) {
      const c = track.corners[i];
      expect(c.id).toBe(i + 1);
      expect(c.apexS).toBeGreaterThanOrEqual(c.sStart);
      expect(c.apexS).toBeLessThanOrEqual(c.sEnd);
      if (i > 0) expect(c.apexS).toBeGreaterThan(track.corners[i - 1].apexS);
    }
  });

  it('minRadius is measured from kappa and physically plausible', () => {
    for (const c of track.corners) {
      expect(c.minRadius).toBeGreaterThan(5);
      expect(c.minRadius).toBeLessThan(500);
    }
    const loop = track.corners.find((c) => c.name === 'The Loop')!;
    expect(loop.minRadius).toBeGreaterThanOrEqual(10);
    expect(loop.minRadius).toBeLessThanOrEqual(45);
    // The Loop is the tightest corner on the lap
    for (const c of track.corners) {
      expect(loop.minRadius).toBeLessThanOrEqual(c.minRadius + 1e-9);
    }
  });
});

describe('zones', () => {
  it('tile [0, length) exactly: no gaps, no overlaps', () => {
    expect(track.zones[0].sStart).toBe(0);
    expect(track.zones[track.zones.length - 1].sEnd).toBe(track.length);
    for (let i = 0; i < track.zones.length; i++) {
      const z = track.zones[i];
      expect(z.id).toBe(i);
      expect(z.sEnd).toBeGreaterThan(z.sStart);
      if (i > 0) expect(z.sStart).toBe(track.zones[i - 1].sEnd);
    }
  });

  it('every corner apex falls in a non-straight zone', () => {
    for (const c of track.corners) {
      const zone = track.zones.find((z) => c.apexS >= z.sStart && c.apexS < z.sEnd)!;
      expect(zone).toBeDefined();
      expect(zone.kind).not.toBe('straight');
    }
  });

  it('the big corners land in their named zones', () => {
    const zoneOf = (s: number) =>
      track.zones.find((z) => s >= z.sStart && s < z.sEnd)!.name;
    expect(zoneOf(894)).toBe('Village Brake');
    expect(zoneOf(1044)).toBe('The Loop');
    expect(zoneOf(2004)).toBe('Brooklands');
    expect(zoneOf(3133)).toBe('Copse');
    expect(zoneOf(5083)).toBe('Stowe');
    expect(zoneOf(5517)).toBe('Vale Brake');
  });

  it('braking/slow zones are not accel zones; the main straights are', () => {
    const byName = new Map(track.zones.map((z) => [z.name, z]));
    for (const name of ['Village Brake', 'The Loop', 'Brooklands', 'Luffield', 'Vale Brake']) {
      expect(byName.get(name)!.accelZone).toBe(false);
    }
    for (const name of [
      'Pit Straight',
      'Wellington Straight',
      'National Straight',
      'Hangar Straight',
    ]) {
      const z = byName.get(name)!;
      expect(z.kind).toBe('straight');
      expect(z.accelZone).toBe(true);
    }
  });
});

describe('override / straight-mode metadata', () => {
  it('has the 4 real 2026 straight-mode zones, pit straight wrapping S/F', () => {
    expect(track.straightModeZones.length).toBe(4);
    const wrapping = track.straightModeZones.filter((z) => z.sStart > z.sEnd);
    expect(wrapping.length).toBe(1);
    const inSpan = (s: number, z: { sStart: number; sEnd: number }) =>
      z.sStart > z.sEnd ? s >= z.sStart || s < z.sEnd : s >= z.sStart && s < z.sEnd;
    expect(inSpan(100, wrapping[0])).toBe(true); // pit straight past S/F
    expect(inSpan(5860, wrapping[0])).toBe(true); // Club exit before S/F
    expect(track.straightModeZones.some((z) => inSpan(1500, z))).toBe(true); // Wellington
    expect(track.straightModeZones.some((z) => inSpan(2800, z))).toBe(true); // National
    expect(track.straightModeZones.some((z) => inSpan(4600, z))).toBe(true); // Hangar
  });

  it('override lines and sector boundaries sit where the 2026 event put them', () => {
    expect(track.detectionLineS).toBe(5600);
    expect(track.activationLineS).toBe(5850);
    expect(track.detectionLineS).toBeLessThan(track.activationLineS);
    expect(track.activationLineS).toBeLessThan(track.length);
    expect(track.sector2S).toBe(1780);
    expect(track.sector3S).toBe(4900);
    expect(track.sector2S).toBeLessThan(track.sector3S);
    expect(track.sector3S).toBeLessThan(track.length);
  });
});

describe('trackAt / wrapS / sDelta', () => {
  it('is continuous: poses 0.5 m apart in s are within 0.6 m in space', () => {
    for (let s = 0; s < track.length; s += 97.3) {
      expect(dist(s, s + 0.5)).toBeLessThan(0.6);
    }
    expect(dist(track.length - 0.25, track.length + 0.25)).toBeLessThan(0.6);
  });

  it('wrapS maps any s into [0, length)', () => {
    expect(wrapS(track, 0)).toBe(0);
    expect(wrapS(track, track.length)).toBe(0);
    expect(wrapS(track, -5)).toBeCloseTo(track.length - 5, 9);
    expect(wrapS(track, track.length + 7)).toBeCloseTo(7, 9);
    expect(wrapS(track, 3 * track.length + 1)).toBeCloseTo(1, 6);
  });

  it('sDelta gives the signed shortest distance from b to a', () => {
    expect(sDelta(track, 100, 40)).toBeCloseTo(60, 9);
    expect(sDelta(track, 40, 100)).toBeCloseTo(-60, 9);
    expect(sDelta(track, 10, track.length - 10)).toBeCloseTo(20, 9); // across S/F
    expect(sDelta(track, track.length - 10, 10)).toBeCloseTo(-20, 9);
    expect(Math.abs(sDelta(track, 0, track.length / 2))).toBeCloseTo(track.length / 2, 9);
  });
});
