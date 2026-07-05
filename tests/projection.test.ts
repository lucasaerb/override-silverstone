import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrackCsv, buildTrack } from '../src/sim/track';
import { AI_MAPS } from '../src/sim/aiDriver';
import { projectLap } from '../src/sim/projection';
import type { DeployMap, TrackData } from '../src/sim/types';

function loadTrack(): TrackData {
  const csv = readFileSync('public/data/silverstone.csv', 'utf8');
  return buildTrack(parseTrackCsv(csv), 'Silverstone');
}

function emptyMap(track: TrackData): DeployMap {
  return { zoneDeploy: track.zones.map(() => 0), zoneLift: track.zones.map(() => 0) };
}

describe('lap projection', () => {
  const track = loadTrack();

  it('projects a plausible flying lap for a deploying map', () => {
    const p = projectLap(track, AI_MAPS.balanced);
    expect(Number.isFinite(p.lapTime)).toBe(true);
    expect(p.lapTime).toBeGreaterThan(85);
    expect(p.lapTime).toBeLessThan(97);
    expect(p.deployedMJ).toBeGreaterThan(1);
    expect(p.topSpeedKmh).toBeGreaterThan(300);
  });

  it('an all-zero deploy map is slower and spends almost nothing', () => {
    const deploying = projectLap(track, AI_MAPS.balanced);
    const passive = projectLap(track, emptyMap(track));
    expect(Number.isFinite(passive.lapTime)).toBe(true);
    expect(passive.lapTime).toBeGreaterThan(deploying.lapTime);
    expect(passive.deployedMJ).toBeLessThan(0.3);
  });

  it('SoC series is normalized and fully populated', () => {
    const p = projectLap(track, AI_MAPS.balanced);
    expect(p.socSeries.length).toBe(track.samples.length);
    for (let i = 0; i < p.socSeries.length; i++) {
      expect(p.socSeries[i]).toBeGreaterThanOrEqual(0);
      expect(p.socSeries[i]).toBeLessThanOrEqual(1.0001);
      expect(Number.isNaN(p.socSeries[i])).toBe(false);
    }
  });

  it('is deterministic (pure function of track + map)', () => {
    const a = projectLap(track, AI_MAPS.balanced);
    const b = projectLap(track, AI_MAPS.balanced);
    expect(a.lapTime).toBe(b.lapTime);
    expect(a.deployedMJ).toBe(b.deployedMJ);
  });
});
