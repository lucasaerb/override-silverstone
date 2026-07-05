import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrackCsv, buildTrack } from '../src/sim/track';
import { simulateLaps } from '../src/sim/projection';
import {
  optimizeDeployMap,
  zoneValueAnalysis,
  heuristicMap,
} from '../src/sim/optimizer';
import { makeSyntheticTrack } from './synthetic';
import type { DeployMap, TrackData } from '../src/sim/types';

function realTrack(): TrackData {
  return buildTrack(parseTrackCsv(readFileSync('public/data/silverstone.csv', 'utf8')), 'Silverstone');
}
function emptyMap(track: TrackData): DeployMap {
  return { zoneDeploy: track.zones.map(() => 0), zoneLift: track.zones.map(() => 0) };
}
const sustained = (track: TrackData, map: DeployMap): number =>
  simulateLaps(track, map, 1, 3).totalRaceTime / 3;

describe('deployment optimizer (Silverstone)', () => {
  const track = realTrack();

  it('improves on its heuristic seed and beats a no-deploy map', () => {
    const res = optimizeDeployMap(track, { raceLaps: 3, maxSweeps: 3 });
    const seed = sustained(track, heuristicMap(track));
    const empty = sustained(track, emptyMap(track));
    expect(Number.isFinite(res.lapTime)).toBe(true);
    expect(res.lapTime).toBeLessThanOrEqual(seed); // ascent never regresses
    expect(res.lapTime).toBeLessThan(seed - 0.5); // and finds real time
    expect(res.lapTime).toBeLessThan(empty - 2); // deploying is worth seconds/lap
  }, 120000);

  it('beats a naive deploy-everything map by balancing deploy and recovery', () => {
    // deploy full everywhere, never harvest: drains the battery and later laps
    // collapse to ICE pace. A balanced strategy must beat it over the race.
    const allDeploy: DeployMap = {
      zoneDeploy: track.zones.map(() => 1),
      zoneLift: track.zones.map(() => 0),
    };
    const res = optimizeDeployMap(track, { raceLaps: 3, maxSweeps: 3 });
    expect(res.lapTime).toBeLessThan(sustained(track, allDeploy));
  }, 120000);

  it('is deterministic', () => {
    const a = optimizeDeployMap(track, { raceLaps: 2, maxSweeps: 2 });
    const b = optimizeDeployMap(track, { raceLaps: 2, maxSweeps: 2 });
    expect(a.map.zoneDeploy).toEqual(b.map.zoneDeploy);
    expect(a.map.zoneLift).toEqual(b.map.zoneLift);
    expect(a.lapTime).toBe(b.lapTime);
  }, 120000);
});

describe('zone value analysis (evidence)', () => {
  const track = realTrack();

  it('produces a meaningful spread and normalizes to [0,1]', () => {
    const a = zoneValueAnalysis(track);
    const values = a.zones.map((z) => z.deployValueSec);
    // some zones clearly pay off, others don't — that's the whole lesson
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.5);
    expect(Math.max(...values)).toBeGreaterThan(0.3); // the best spot saves real time
    for (const z of a.zones) {
      expect(z.valueNorm).toBeGreaterThanOrEqual(0);
      expect(z.valueNorm).toBeLessThanOrEqual(1.0001);
    }
    expect(a.zones[a.bestZoneId].valueNorm).toBeCloseTo(1, 5);
  }, 120000);
});

describe('track-agnostic: runs on a synthetic circuit', () => {
  it('optimizes a stadium track with no Silverstone-specific code', () => {
    const track = makeSyntheticTrack({ kind: 'stadium', straight: 900, radius: 55 });
    const res = optimizeDeployMap(track, { raceLaps: 2, maxSweeps: 2 });
    const empty = sustained(track, emptyMap(track));
    expect(Number.isFinite(res.lapTime)).toBe(true);
    expect(res.lapTime).toBeLessThan(empty); // deploying helps here too
    const a = zoneValueAnalysis(track);
    expect(a.zones.length).toBe(track.zones.length);
    // at least one zone is a clearly valuable place to deploy
    expect(Math.max(...a.zones.map((z) => z.deployValueSec))).toBeGreaterThan(0.1);
  }, 120000);
});
