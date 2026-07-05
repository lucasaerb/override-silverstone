/**
 * AI driver unit suite: map validity for the 19 real Silverstone zones, the
 * live defensive/aggressive map swaps, boost-zone discipline and the
 * aggressiveness envelope.
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { AI_MAPS, isBoostZone, updateAi } from '../src/sim/aiDriver';
import { PU } from '../src/sim/constants';
import { Rng } from '../src/sim/rng';
import { buildTrack, parseTrackCsv } from '../src/sim/track';
import type { CarState } from '../src/sim/types';
import { makeCar } from './synthetic';

const csv = readFileSync('public/data/silverstone.csv', 'utf8');
const track = buildTrack(parseTrackCsv(csv), 'Silverstone');

/** fresh rival/player pair; rival starts on its own balanced-map clone */
function pair(patch: Partial<CarState> = {}): { rival: CarState; player: CarState } {
  const rival = makeCar('rival', track, { v: 50, ...patch });
  rival.deployMap = {
    zoneDeploy: [...AI_MAPS.balanced.zoneDeploy],
    zoneLift: [...AI_MAPS.balanced.zoneLift],
  };
  const player = makeCar('player', track, { v: 50 });
  return { rival, player };
}

describe('AI_MAPS validity', () => {
  it('covers every real zone id with levels in [0, 1]', () => {
    expect(track.zones).toHaveLength(19);
    for (const [name, map] of Object.entries(AI_MAPS)) {
      expect(map.zoneDeploy, `${name}.zoneDeploy`).toHaveLength(track.zones.length);
      expect(map.zoneLift, `${name}.zoneLift`).toHaveLength(track.zones.length);
      for (const zone of track.zones) {
        expect(zone.id).toBeGreaterThanOrEqual(0);
        expect(zone.id).toBeLessThan(map.zoneDeploy.length);
        for (const arr of [map.zoneDeploy, map.zoneLift]) {
          expect(arr[zone.id], `${name} zone ${zone.id}`).toBeGreaterThanOrEqual(0);
          expect(arr[zone.id], `${name} zone ${zone.id}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('personalities differ where it matters', () => {
    // aggressive deploys strictly more than balanced overall, defensive keeps
    // the straights but trims the exits
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(AI_MAPS.aggressive.zoneDeploy)).toBeGreaterThan(sum(AI_MAPS.balanced.zoneDeploy));
    expect(sum(AI_MAPS.aggressive.zoneLift)).toBeLessThan(sum(AI_MAPS.balanced.zoneLift));
    const wellington = track.zones.find((z) => z.name === 'Wellington Straight')!;
    const hangar = track.zones.find((z) => z.name === 'Hangar Straight')!;
    expect(AI_MAPS.defensive.zoneDeploy[wellington.id]).toBe(1);
    expect(AI_MAPS.defensive.zoneDeploy[hangar.id]).toBe(1);
  });
});

describe('live map swap', () => {
  it('swaps to defensive when the player is behind within 1.2 s', () => {
    const { rival, player } = pair();
    rival.s = 1000;
    player.s = 1000 - 50; // 50 m behind at 50 m/s = 1.0 s
    updateAi(rival, player, track, new Rng(1), 0);
    expect(rival.deployMap).toEqual(AI_MAPS.defensive);
  });

  it('swaps to aggressive when the player is ahead within 1.2 s', () => {
    const { rival, player } = pair();
    rival.s = 1000;
    player.s = 1000 + 50;
    updateAi(rival, player, track, new Rng(1), 0);
    expect(rival.deployMap).toEqual(AI_MAPS.aggressive);
  });

  it('returns to the neutral map when the gap opens beyond 1.2 s', () => {
    const { rival, player } = pair();
    const rng = new Rng(1);
    rival.s = 1000;
    player.s = 1000 - 50;
    updateAi(rival, player, track, rng, 0);
    expect(rival.deployMap).toEqual(AI_MAPS.defensive);
    player.s = 1000 - 80; // 1.6 s back
    updateAi(rival, player, track, rng, 0);
    expect(rival.deployMap).toEqual(AI_MAPS.balanced);
    player.s = 1000 + 80; // 1.6 s ahead
    updateAi(rival, player, track, rng, 0);
    expect(rival.deployMap).toEqual(AI_MAPS.balanced);
  });

  it('the 1.2 s trigger is evaluated on time gap, not raw distance', () => {
    const { rival, player } = pair({ v: 90 });
    player.v = 90;
    rival.s = 4500;
    player.s = 4500 - 100; // 100 m at 90 m/s = 1.11 s -> attacked
    updateAi(rival, player, track, new Rng(1), 0);
    expect(rival.deployMap).toEqual(AI_MAPS.defensive);
    const slow = pair({ v: 30 });
    slow.player.v = 30;
    slow.rival.s = 1050;
    slow.player.s = 1050 - 100; // 100 m at 30 m/s = 3.3 s -> no threat
    updateAi(slow.rival, slow.player, track, new Rng(1), 0);
    expect(slow.rival.deployMap).toEqual(AI_MAPS.balanced);
  });
});

describe('boost discipline', () => {
  function boostAt(s: number, opts: { armed?: boolean; soc?: number } = {}): boolean {
    const { rival, player } = pair();
    rival.s = s;
    player.s = (s + track.length / 2) % track.length; // far away
    rival.energy.overrideArmed = opts.armed ?? true;
    rival.energy.soc = opts.soc ?? PU.ES_WINDOW;
    updateAi(rival, player, track, new Rng(1), 0);
    return rival.inputs.boostHeld;
  }

  it('holds boost on the straight-mode straights when armed and charged', () => {
    expect(boostAt(1500)).toBe(true); // Wellington
    expect(boostAt(4600)).toBe(true); // Hangar
    expect(boostAt(2800)).toBe(true); // National
    expect(boostAt(100)).toBe(true); // pit straight (wrapped span)
  });

  it('never boosts in the corners', () => {
    expect(boostAt(1050)).toBe(false); // The Loop
    expect(boostAt(2100)).toBe(false); // Luffield
    expect(boostAt(3900)).toBe(false); // Becketts
    expect(boostAt(5450)).toBe(false); // Vale braking
  });

  it('never boosts unarmed or with a flat battery', () => {
    expect(boostAt(1500, { armed: false })).toBe(false);
    expect(boostAt(1500, { soc: 0.5e6 })).toBe(false); // below the 0.8 MJ floor
    expect(isBoostZone(track, 1500)).toBe(true); // the zone itself was fine
  });
});

describe('aggressiveness envelope', () => {
  function aggressivenessFor(setup: (rival: CarState, player: CarState) => void): number {
    const { rival, player } = pair();
    rival.s = 1000;
    player.s = 1000 - 500; // default: no fight
    setup(rival, player);
    updateAi(rival, player, track, new Rng(7), 0);
    return rival.inputs.aggressiveness;
  }

  const JITTER = 0.021; // spec jitter 0.02 + fp headroom

  it('base is 1.0 with only the per-lap jitter', () => {
    const a = aggressivenessFor(() => {});
    expect(Math.abs(a - 1)).toBeLessThanOrEqual(JITTER);
  });

  it('+0.1 in the final two laps when the fight is within 1.5 s', () => {
    const a = aggressivenessFor((rival, player) => {
      rival.lap = 4; // lap 4 of 5
      player.lap = 4;
      player.s = rival.s - 40; // 0.8 s back
    });
    expect(Math.abs(a - 1.1)).toBeLessThanOrEqual(JITTER);
    // ...but not earlier in the race
    const early = aggressivenessFor((rival, player) => {
      rival.lap = 2;
      player.lap = 2;
      player.s = rival.s - 40;
    });
    expect(Math.abs(early - 1)).toBeLessThanOrEqual(JITTER);
  });

  it('-0.15 to rebuild when the battery is under 15%', () => {
    const a = aggressivenessFor((rival) => {
      rival.energy.soc = 0.1 * PU.ES_WINDOW;
    });
    expect(Math.abs(a - 0.85)).toBeLessThanOrEqual(JITTER);
  });

  it('stays inside the CarInputs contract bounds in every combination', () => {
    const scenarios: Array<(r: CarState, p: CarState) => void> = [
      () => {},
      (r) => (r.energy.soc = 0),
      (r, p) => {
        r.lap = 5;
        p.lap = 5;
        p.s = r.s - 10;
      },
      (r, p) => {
        r.lap = 5;
        p.lap = 5;
        p.s = r.s - 10;
        r.energy.soc = 0.05 * PU.ES_WINDOW;
      },
    ];
    for (const setup of scenarios) {
      const a = aggressivenessFor(setup);
      expect(a).toBeGreaterThanOrEqual(0.5);
      expect(a).toBeLessThanOrEqual(1.25);
    }
  });

  it('jitter is drawn once per lap, not per tick', () => {
    const { rival, player } = pair();
    rival.s = 1000;
    player.s = 200;
    const rng = new Rng(99);
    updateAi(rival, player, track, rng, 0);
    const first = rival.inputs.aggressiveness;
    for (let i = 0; i < 50; i++) updateAi(rival, player, track, rng, i / 120);
    expect(rival.inputs.aggressiveness).toBe(first); // same lap -> same jitter
    rival.lap = 1; // lap rollover -> one fresh draw allowed
    updateAi(rival, player, track, rng, 1);
    const second = rival.inputs.aggressiveness;
    for (let i = 0; i < 50; i++) updateAi(rival, player, track, rng, 2 + i / 120);
    expect(rival.inputs.aggressiveness).toBe(second);
  });
});
