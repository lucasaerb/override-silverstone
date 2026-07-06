/**
 * RaceController integration suite on the real Silverstone track: full-race
 * completion, determinism, the Manual Override pass, the standing-start
 * MGU-K rule, the visual no-overlap guarantee, and THE BALANCE PROOF — the
 * core game promise that the race is winnable through deployment strategy.
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { PU, SIM, deployCapNormalW } from '../src/sim/constants';
import { AI_MAPS, isBoostZone } from '../src/sim/aiDriver';
import { RaceController } from '../src/sim/race';
import { buildTrack, parseTrackCsv, sDelta } from '../src/sim/track';
import type { CarState, DeployMap, RaceState } from '../src/sim/types';

const csv = readFileSync('public/data/silverstone.csv', 'utf8');
const track = buildTrack(parseTrackCsv(csv), 'Silverstone');

/**
 * THE "PERFECT STRATEGY" MAP — the tutorial hint. Hand-tuned against the AI:
 * deploy concentrated where the passes happen (Wellington, Hangar, the pit
 * straight and every exit feeding them: Aintree, Woodcote, Chapel, Club),
 * clip through Abbey-Farm (the real 2026 "clip T1-T2, bank for Wellington"
 * move), superclip-harvest Maggotts/Becketts + Brooklands/Luffield, and lift
 * into Village/Vale/Stowe. The cycle deploys ~7 MJ/lap where it buys the
 * most distance and keeps the corner exits powered — worth ~2 s/lap over
 * AI_MAPS.balanced, enough to hold the rival outside striking range.
 */
const PERFECT_MAP: DeployMap = {
  //           Pit  A-F  Vil  Loop Ain  Wel  Bro  Luf  Woo  Nat  Cop  Mag  Bec  Cha  Han  Sto  Val  Clu  CEx
  zoneDeploy: [1, 0, 0.5, 0.75, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0.25, 0.25, 1, 1],
  zoneLift: [0, 0, 0.25, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.75, 0],
};

const ZERO_MAP: DeployMap = {
  zoneDeploy: track.zones.map(() => 0),
  zoneLift: track.zones.map(() => 0),
};

function carOf(state: RaceState, id: 'player' | 'rival'): CarState {
  const car = state.cars.find((c) => c.id === id);
  if (!car) throw new Error(`no ${id} in state`);
  return car;
}

/** the test-6 "simple boost logic": hold when armed on straights, keep 0.8 MJ */
function playerBoostLogic(player: CarState): void {
  player.inputs.boostHeld =
    player.energy.overrideArmed && player.energy.soc > 0.8e6 && isBoostZone(track, player.s);
}

interface RunResult {
  rc: RaceController;
  state: RaceState;
  player: CarState;
  rival: CarState;
  wallMs: number;
  gapSamples: number[];
}

function runRace(
  opts: { seed: number; playerMap?: DeployMap; boost?: boolean },
  onTick?: (state: RaceState) => void,
): RunResult {
  const rc = new RaceController(track, { seed: opts.seed, playerMap: opts.playerMap });
  const state = rc.getState();
  const player = carOf(state, 'player');
  const rival = carOf(state, 'rival');
  rc.start();
  const gapSamples: number[] = [];
  const t0 = performance.now();
  let guard = 0;
  while (state.phase !== 'finished' && guard++ < 300_000) {
    if (opts.boost) playerBoostLogic(player);
    rc.step();
    if (state.tick % 120 === 0) gapSamples.push(state.gapSeconds);
    onTick?.(state);
  }
  const wallMs = performance.now() - t0;
  expect(state.phase).toBe('finished');
  return { rc, state, player, rival, wallMs, gapSamples };
}

describe('full race', () => {
  const run = runRace({ seed: 42, playerMap: AI_MAPS.balanced });

  it('completes 5 laps for both cars with flying laps in [88, 96] s', () => {
    expect(run.player.finished).toBe(true);
    expect(run.rival.finished).toBe(true);
    expect(run.player.lapTimes).toHaveLength(SIM.RACE_LAPS);
    expect(run.rival.lapTimes).toHaveLength(SIM.RACE_LAPS);
    for (const lap of [...run.player.lapTimes, ...run.rival.lapTimes]) {
      expect(lap).toBeGreaterThan(87.5); // race pace, ~quali pole down to +8s
      expect(lap).toBeLessThan(96);
    }
  });

  it('logs race-start, 10 lap-completes and 2 finishes', () => {
    const count = (kind: string) => run.state.events.filter((e) => e.kind === kind).length;
    expect(count('race-start')).toBe(1);
    expect(count('lap-complete')).toBe(10);
    expect(count('finish')).toBe(2);
    // every lap-complete carries its lap time
    for (const e of run.state.events) {
      if (e.kind === 'lap-complete') {
        expect(e.data?.lapTime).toBeGreaterThan(85);
      }
    }
  });

  it('gapSeconds evolves over the race', () => {
    const min = Math.min(...run.gapSamples);
    const max = Math.max(...run.gapSamples);
    expect(max - min).toBeGreaterThan(0.05);
  });

  it('step() is a no-op after the finish', () => {
    const tick = run.state.tick;
    const gap = run.state.gapSeconds;
    run.rc.step();
    run.rc.step();
    expect(run.state.tick).toBe(tick);
    expect(run.state.gapSeconds).toBe(gap);
  });

  it(`runs far faster than realtime (needs >= 50x for fast-forward)`, () => {
    expect(run.wallMs).toBeLessThan(10_000);
    const speedup = (run.state.time * 1000) / run.wallMs;
    // eslint-disable-next-line no-console
    console.log(
      `race sim: ${run.wallMs.toFixed(0)} ms wall for ${run.state.time.toFixed(1)} s sim ` +
        `(${(run.wallMs / SIM.RACE_LAPS).toFixed(1)} ms per race lap, ${speedup.toFixed(0)}x realtime)`,
    );
    expect(speedup).toBeGreaterThan(50);
  });
});

describe('phases', () => {
  it('grid -> countdown (3 s) -> racing with a race-start event', () => {
    const rc = new RaceController(track, { seed: 1 });
    const state = rc.getState();
    expect(state.phase).toBe('grid');
    rc.step(); // no-op before start()
    expect(state.tick).toBe(0);
    rc.start();
    expect(state.phase).toBe('countdown');
    const countdownTicks = Math.round(3 / SIM.DT);
    for (let i = 0; i < countdownTicks - 1; i++) rc.step();
    expect(state.phase).toBe('countdown');
    expect(carOf(state, 'player').v).toBe(0); // nobody moves on the grid
    rc.step();
    expect(state.phase).toBe('racing');
    expect(state.time).toBe(0);
    expect(state.events.some((e) => e.kind === 'race-start')).toBe(true);
  });
});

describe('determinism', () => {
  const hash = (r: RunResult) =>
    JSON.stringify({ cars: r.state.cars, events: r.state.events, gap: r.state.gapSeconds });

  it('same seed twice: identical event log and final state', () => {
    const a = runRace({ seed: 42, playerMap: AI_MAPS.balanced });
    const b = runRace({ seed: 42, playerMap: AI_MAPS.balanced });
    expect(b.state.events).toEqual(a.state.events);
    expect(hash(b)).toBe(hash(a));
  });

  it('different seed: different final gap', () => {
    const a = runRace({ seed: 42, playerMap: AI_MAPS.balanced });
    const b = runRace({ seed: 1337, playerMap: AI_MAPS.balanced });
    expect(b.state.gapSeconds).not.toBe(a.state.gapSeconds);
  });
});

describe('manual override integration', () => {
  it('arming at the detection line unlocks >337 km/h deploy on the pit straight', () => {
    const rc = new RaceController(track, { seed: 7, playerMap: PERFECT_MAP });
    const state = rc.getState();
    const player = carOf(state, 'player');
    const rival = carOf(state, 'rival');
    rc.start();
    while (state.phase === 'countdown') rc.step();
    // engineer the pass: rival just before the detection line, player ~0.75 s
    // behind at Club-corner speed (mutating the live state is the documented
    // test/debug surface)
    rival.s = track.detectionLineS - 30;
    rival.v = 70;
    rival.lap = 1;
    player.s = track.detectionLineS - 55;
    player.v = 72;
    player.lap = 1;

    let armedEvent = false;
    let exceeded = false;
    let vAtExceed = 0;
    for (let i = 0; i < 120 * 30 && state.phase === 'racing'; i++) {
      player.inputs.boostHeld = player.energy.overrideArmed; // force boost once armed
      rc.step();
      if (!armedEvent) {
        armedEvent = state.events.some(
          (e) => e.kind === 'override-armed' && e.carId === 'player',
        );
      }
      const vKmh = player.v * 3.6;
      const onPitStraight = player.s >= track.length - 160 || player.s < 340;
      if (
        onPitStraight &&
        vKmh > 337 &&
        player.energy.overrideActive &&
        player.deployPowerW > deployCapNormalW(vKmh) + 1e3
      ) {
        exceeded = true;
        vAtExceed = Math.max(vAtExceed, vKmh);
      }
    }
    expect(armedEvent).toBe(true);
    expect(exceeded).toBe(true);
    expect(vAtExceed).toBeGreaterThan(337);
  });
});

describe('standing start', () => {
  it('no MGU-K propulsion below 50 km/h on the opening launch', () => {
    const rc = new RaceController(track, { seed: 3, playerMap: AI_MAPS.balanced });
    const state = rc.getState();
    rc.start();
    while (state.phase === 'countdown') rc.step();
    const launched: Record<string, boolean> = { player: false, rival: false };
    let probes = 0;
    while ((!launched.player || !launched.rival) && state.tick < 120 * 30) {
      rc.step();
      for (const car of state.cars) {
        if (launched[car.id]) continue;
        if (car.v >= PU.K_MIN_SPEED_STANDING_START) {
          launched[car.id] = true;
        } else {
          probes++;
          expect(car.deployPowerW, `${car.id} deployed below 50 km/h`).toBeLessThanOrEqual(0);
        }
      }
    }
    expect(launched.player && launched.rival).toBe(true);
    expect(probes).toBeGreaterThan(100); // the launch was actually observed
  });
});

describe('overlap guard', () => {
  it('cars never visually overlap through a full race', () => {
    let checked = 0;
    runRace({ seed: 42, playerMap: AI_MAPS.balanced }, (state) => {
      const p = carOf(state, 'player');
      const r = carOf(state, 'rival');
      const ds = Math.abs(sDelta(track, p.s, r.s));
      if (ds < 5) {
        checked++;
        expect(
          Math.abs(p.lateralOffset - r.lateralOffset),
          `overlap at tick ${state.tick}: ds=${ds.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(2.5);
      }
    });
    expect(checked).toBeGreaterThan(0); // the duel actually got close
  });
});

describe('THE BALANCE PROOF', () => {
  it('perfect strategy + simple boost beats the balanced rival from P2', () => {
    const run = runRace({ seed: 42, playerMap: PERFECT_MAP, boost: true });
    const firstFinish = run.state.events.find((e) => e.kind === 'finish');
    expect(firstFinish?.carId).toBe('player');
    expect(run.state.gapSeconds).toBeLessThan(0); // negative = player ahead
    // eslint-disable-next-line no-console
    console.log(`balance proof: player wins by ${(-run.state.gapSeconds).toFixed(3)} s`);
    // a real strategic margin, not a photo finish
    expect(-run.state.gapSeconds).toBeGreaterThan(0.2);
  });

  it('sanity inverse: an all-zeros deploy map loses', () => {
    const run = runRace({ seed: 42, playerMap: ZERO_MAP, boost: true });
    const firstFinish = run.state.events.find((e) => e.kind === 'finish');
    expect(firstFinish?.carId).toBe('rival');
    expect(run.state.gapSeconds).toBeGreaterThan(0); // player behind
    // eslint-disable-next-line no-console
    console.log(`sanity inverse: player loses by ${run.state.gapSeconds.toFixed(3)} s`);
  });
});

describe('N-car (multiplayer) grid', () => {
  it('runs a 4-car race to a clean classification with one winner', () => {
    const rc = new RaceController(track, {
      seed: 7,
      laps: 2,
      cars: [
        { id: 'p0', name: 'Alice', human: true, map: PERFECT_MAP },
        { id: 'p1', name: 'Bob', human: true, map: AI_MAPS.balanced },
        { id: 'p2', name: 'Cara', human: true, map: AI_MAPS.balanced },
        { id: 'p3', name: 'Dan', human: true, map: ZERO_MAP },
      ],
    });
    const st = rc.getState();
    expect(st.cars).toHaveLength(4);
    expect(st.cars.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Cara', 'Dan']);
    rc.start(0);
    let guard = 0;
    while (st.phase !== 'finished' && guard < 120 * 400) { rc.step(); guard++; }
    expect(st.phase).toBe('finished');
    // every car finished with a recorded finish time
    expect(st.cars.every((c) => c.finished && c.finishTime !== null)).toBe(true);
    // exactly one winner (min finish time), and each finish emitted an event
    const finishes = st.events.filter((e) => e.kind === 'finish');
    expect(finishes).toHaveLength(4);
    const winner = st.cars.reduce((a, b) => (a.finishTime! <= b.finishTime! ? a : b));
    // the strongest map (Alice) should not be beaten by the zero map (Dan)
    const alice = st.cars.find((c) => c.id === 'p0')!;
    const dan = st.cars.find((c) => c.id === 'p3')!;
    expect(alice.finishTime!).toBeLessThan(dan.finishTime!);
    // eslint-disable-next-line no-console
    console.log(`4-car race winner: ${winner.name} @ ${winner.finishTime!.toFixed(2)}s`);
  });

  it('keeps all four cars laterally separated (no overlap) throughout', () => {
    const rc = new RaceController(track, {
      seed: 3,
      laps: 1,
      cars: [0, 1, 2, 3].map((i) => ({ id: `p${i}`, human: true, map: AI_MAPS.balanced })),
    });
    const st = rc.getState();
    rc.start(0);
    let guard = 0;
    while (st.phase !== 'finished' && guard < 120 * 300) {
      rc.step();
      for (let i = 0; i < st.cars.length; i++) {
        for (let j = i + 1; j < st.cars.length; j++) {
          const a = st.cars[i], b = st.cars[j];
          if (Math.abs(sDelta(track, a.s, b.s)) < 5.5 && !a.finished && !b.finished) {
            expect(Math.abs(a.lateralOffset - b.lateralOffset)).toBeGreaterThanOrEqual(2.5);
          }
        }
      }
      guard++;
    }
    expect(st.phase).toBe('finished');
  });
});
