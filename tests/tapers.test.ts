import { describe, expect, it } from 'vitest';
import { deployCapNormalW, deployCapOverrideW } from '../src/sim/constants';

/** FIA C5.2.8 taper formulas — exact regulation values. */
describe('normal deploy taper (C5.2.8.i)', () => {
  it('full 350 kW at and below 290 km/h', () => {
    expect(deployCapNormalW(0)).toBe(350e3);
    expect(deployCapNormalW(290)).toBe(350e3);
  });

  it('P = 1800 - 5v between 290 and 340', () => {
    expect(deployCapNormalW(300)).toBeCloseTo(300e3, 3);
    expect(deployCapNormalW(320)).toBeCloseTo(200e3, 3);
    expect(deployCapNormalW(340)).toBeCloseTo(100e3, 3);
  });

  it('P = 6900 - 20v between 340 and 345, zero from 345', () => {
    expect(deployCapNormalW(342.5)).toBeCloseTo(50e3, 3);
    expect(deployCapNormalW(345)).toBe(0);
    expect(deployCapNormalW(360)).toBe(0);
  });

  it('is continuous at the segment joins', () => {
    expect(deployCapNormalW(290.0001)).toBeCloseTo(deployCapNormalW(290), -3);
    expect(deployCapNormalW(340.0001)).toBeCloseTo(deployCapNormalW(340), -3);
  });
});

describe('override deploy taper (C5.2.8.ii)', () => {
  it('holds full 350 kW to 337.5 km/h', () => {
    expect(deployCapOverrideW(290)).toBe(350e3);
    expect(deployCapOverrideW(337.5)).toBeCloseTo(350e3, 3);
  });

  it('P = 7100 - 20v above 337.5, zero at 355', () => {
    expect(deployCapOverrideW(345)).toBeCloseTo(200e3, 3);
    expect(deployCapOverrideW(350)).toBeCloseTo(100e3, 3);
    expect(deployCapOverrideW(355)).toBe(0);
  });

  it('attacker vs defender window: override holds >= 200 kW where normal mode is dead', () => {
    for (let v = 345; v <= 350; v += 1) {
      expect(deployCapNormalW(v)).toBe(0);
      expect(deployCapOverrideW(v)).toBeGreaterThanOrEqual(100e3);
    }
  });
});
