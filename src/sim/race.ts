/**
 * RaceController: the two-car duel state machine. Owns the cars, the phase
 * flow (grid -> countdown -> racing -> finished), the event log, the AI
 * driver hookup and the (visual-only) lateral overtake animation.
 *
 * Determinism: step() is a pure function of (seed, inputs so far). Cars are
 * always advanced rival-first-then-player; the only rng consumer is the AI's
 * once-per-lap jitter. Two controllers with the same seed and the same
 * per-tick input mutations replay tick-exactly.
 *
 * getState() returns the LIVE state object — no defensive copying per tick.
 * Callers may mutate `cars[i].inputs` (that is the sanctioned control
 * surface, mirroring the debug API); everything else must be treated as
 * read-only or determinism/replay guarantees are void.
 */
import type { CarState, DeployMap, RaceEvent, RaceState, TrackData } from './types';
import { PU, SIM } from './constants';
import { computeVLimit, stepCar, timeGapSeconds } from './physics';
import { computeRacingLine, type RacingLine } from './racingLine';
import { sDelta } from './track';
import { Rng } from './rng';
import { AI_MAPS, cloneDeployMap, updateAi } from './aiDriver';

export interface RaceOptions {
  laps?: number;
  session?: RaceState['session'];
  seed: number;
  playerMap?: DeployMap;
  rivalMap?: DeployMap;
  rivalSkill?: 'balanced' | 'aggressive' | 'defensive';
  /** solo hot-lap: the rival stays parked and never interacts (no tow); the
   *  race finishes when the player alone completes the lap count. */
  solo?: boolean;
  /** multiplayer: the rival is a human — skip the AI driver so its inputs
   *  (set externally each tick from the remote peer) are used verbatim. */
  humanRival?: boolean;
  /** grid gap the player starts behind the rival, m (overtake challenge uses a
   *  larger value); default GRID_P2_BACK_M. */
  playerStartBackM?: number;
  /** N-car (2-4) grid for multiplayer. When given, overrides the player/rival
   *  construction: the controller runs exactly these cars in array order. */
  cars?: CarSpec[];
}

/** One entrant on an N-car (2-4) grid. */
export interface CarSpec {
  id: string;
  name?: string;
  /** human = external inputs each tick (skip AI); false = AI-driven */
  human: boolean;
  map?: DeployMap;
}

// ---------------------------------------------------------------- constants

const COUNTDOWN_S = 3.0;
/** grid slots behind the S/F line, m */
const GRID_P1_BACK_M = 12;
const GRID_P2_BACK_M = 20;
/** per-row grid spacing for the N-car (multiplayer) grid, m */
const GRID_ROW_M = 8;
/** alternating grid-box lateral offset, m */
const GRID_LATERAL_M = 2.5;

// -- lateral overtake animation (visual only — never feeds back into physics)
/** attack begins within this distance behind the car ahead, m */
const ATTACK_RANGE_M = 25;
/** ...or, regardless of closing speed, when tucked in this close, m */
const PROX_RANGE_M = 8;
/** proximity attack releases only beyond this (hysteresis), m */
const PROX_EXIT_M = 10;
/** required closing speed to start a move, m/s */
const ATTACK_CLOSING_MS = 0.5;
/** offset the attacker pulls out to, m */
const ATTACK_OFFSET_M = 3.2;
/** the move is over once the attacker is this far ahead, m */
const CLEAR_AHEAD_M = 12;
/** cars closer than this along-track count as overlapped, m */
const OVERLAP_SPAN_M = 5.5;
/** minimum lateral separation while overlapped, m */
const MIN_LATERAL_SEP_M = 2.8;
/** lateral ease rate, m/s */
const LATERAL_EASE_RATE = 4;

/** 'energy-depleted' fires when soc first drops under this fraction of ES_WINDOW on a lap */
const DEPLETED_SOC_FRAC = 0.02;

// ---------------------------------------------------------------- helpers

function createCar(id: CarState['id'], map: DeployMap, s: number, lateral: number): CarState {
  return {
    id,
    s,
    lap: 0,
    v: 0,
    lateralOffset: lateral,
    energy: {
      soc: PU.ES_WINDOW,
      harvestedThisLap: 0,
      deployedThisLap: 0,
      overrideArmed: false,
      overrideActive: false,
      overrideBonusRemaining: 0,
      lastDeployPowerW: 0,
    },
    deployMap: map,
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
  };
}

/** controller-side per-car state that has no slot in the CarState contract */
interface CarCtl {
  /** true once the car has first reached K_MIN_SPEED_STANDING_START */
  launchDone: boolean;
  /** lateral overtake animation state */
  attacking: boolean;
  side: 1 | -1;
  /** 'energy-depleted' already fired this lap */
  depleted: boolean;
  /** precise S/F-crossing race time when this car finished, s */
  finishTime: number | null;
}

const newCtl = (): CarCtl => ({
  launchDone: false,
  attacking: false,
  side: 1,
  depleted: false,
  finishTime: null,
});

// ---------------------------------------------------------------- controller

export class RaceController {
  readonly track: TrackData;
  /** racing line (offsets + curvature); render places cars with its offsets */
  readonly line: RacingLine;
  /** per-sample speed limit computed from the racing-line curvature */
  readonly vLimit: Float32Array;

  private readonly state: RaceState;
  private readonly rng: Rng;
  private readonly player: CarState;
  private readonly rival: CarState;
  private readonly ctl: Record<string, CarCtl>;
  private countdownTicks = 0;
  private leaderId: string = 'rival';
  private winnerTime: number | null = null;
  private readonly solo: boolean;
  private readonly humanRival: boolean;
  /** true for the classic 2-car player/rival grid (single-player). N-car
   *  multiplayer grids take the generalized stepN() path. */
  private readonly twoCar: boolean;
  /** car ids driven by the AI (skip external inputs) */
  private readonly aiIds: Set<string>;

  constructor(track: TrackData, opts: RaceOptions) {
    this.track = track;
    this.line = computeRacingLine(track);
    this.vLimit = computeVLimit(track, this.line.kappa);
    this.rng = new Rng(opts.seed);
    this.solo = opts.solo ?? false;
    this.humanRival = opts.humanRival ?? false;

    let cars: CarState[];
    if (opts.cars && opts.cars.length >= 2) {
      // N-car (2-4) multiplayer grid: entrants in array order, staggered rows
      // front-to-back with alternating grid-box sides. cars[0] starts on pole.
      this.twoCar = false;
      this.aiIds = new Set(opts.cars.filter((c) => !c.human).map((c) => c.id));
      cars = opts.cars.map((spec, i) => {
        const car = createCar(
          spec.id,
          cloneDeployMap(spec.map ?? AI_MAPS.balanced),
          track.length - (GRID_P1_BACK_M + i * GRID_ROW_M),
          (i % 2 === 0 ? 1 : -1) * GRID_LATERAL_M,
        );
        car.name = spec.name;
        return car;
      });
      this.player = cars[0];
      this.rival = cars[1];
      this.leaderId = cars[0].id;
    } else {
      // classic 2-car player/rival grid (single-player): rival on pole ahead
      this.twoCar = true;
      this.aiIds = new Set(this.humanRival ? [] : ['rival']);
      this.player = createCar(
        'player',
        cloneDeployMap(opts.playerMap ?? AI_MAPS.balanced),
        track.length - (opts.playerStartBackM ?? GRID_P2_BACK_M),
        -GRID_LATERAL_M,
      );
      this.rival = createCar(
        'rival',
        cloneDeployMap(opts.rivalMap ?? AI_MAPS[opts.rivalSkill ?? 'balanced']),
        track.length - GRID_P1_BACK_M,
        GRID_LATERAL_M,
      );
      cars = [this.player, this.rival];
    }
    this.ctl = Object.fromEntries(cars.map((c) => [c.id, newCtl()]));
    this.state = {
      tick: 0,
      time: 0,
      phase: 'grid',
      session: opts.session ?? 'race',
      lapsTotal: opts.laps ?? SIM.RACE_LAPS,
      cars,
      gapSeconds: 0,
      events: [],
    };
    this.state.gapSeconds = this.computeGap();
  }

  /** Live state object — see the module doc for the mutation contract. */
  getState(): RaceState {
    return this.state;
  }

  /** Begin the race. `countdownS` is the grid hold before racing (0 = start
   *  immediately, used when an external start-light sequence drives the launch). */
  start(countdownS: number = COUNTDOWN_S): void {
    if (this.state.phase !== 'grid') return;
    this.state.phase = 'countdown';
    this.countdownTicks = Math.round(countdownS / SIM.DT);
  }

  /** Advance the race by exactly one SIM.DT tick. */
  step(): void {
    const st = this.state;
    if (st.phase === 'grid' || st.phase === 'finished') return;
    st.tick++;
    if (st.phase === 'countdown') {
      if (--this.countdownTicks <= 0) {
        st.phase = 'racing';
        st.time = 0;
        this.emit('race-start', 'player');
      }
      return;
    }
    const t = st.time;
    if (!this.twoCar) { this.stepN(t); return; }
    if (this.solo) {
      // solo hot-lap: only the player runs, with no other car (no tow); the
      // rival stays parked on the grid and is hidden by the renderer.
      this.stepOne(this.player, null, t);
      st.time = t + SIM.DT;
      if (this.player.finished) st.phase = 'finished';
      return;
    }
    if (!this.humanRival) updateAi(this.rival, this.player, this.track, this.rng, t, st.lapsTotal);
    this.stepOne(this.rival, this.player, t);
    this.stepOne(this.player, this.rival, t);
    st.time = t + SIM.DT;
    this.updateLateral(SIM.DT);

    const leader = this.leaderNow();
    if (leader !== this.leaderId) {
      if (!this.player.finished && !this.rival.finished) {
        this.emit('overtake', leader, { lap: leader === 'player' ? this.player.lap : this.rival.lap });
      }
      this.leaderId = leader;
    }
    if (this.player.finished && this.rival.finished) {
      st.phase = 'finished'; // gapSeconds frozen at the final crossing delta
    } else {
      st.gapSeconds = this.computeGap();
    }
  }

  // -------------------------------------------------------------- internals

  private emit(kind: RaceEvent['kind'], carId: RaceEvent['carId'], data?: RaceEvent['data']): void {
    this.state.events.push({ tick: this.state.tick, kind, carId, ...(data ? { data } : {}) });
  }

  private progress(car: CarState): number {
    return car.lap * this.track.length + car.s;
  }

  private leaderNow(): string {
    const p = this.progress(this.player);
    const r = this.progress(this.rival);
    if (p === r) return this.leaderId; // ties keep the current order
    return p > r ? 'player' : 'rival';
  }

  /** signed player-minus-rival time gap: negative = player ahead */
  private computeGap(): number {
    const p = this.progress(this.player);
    const r = this.progress(this.rival);
    if (p === r) return 0;
    return p > r
      ? -timeGapSeconds(this.rival, this.player, this.track)
      : timeGapSeconds(this.player, this.rival, this.track);
  }

  // ---------------------------------------------- N-car (multiplayer) stepping

  /** Advance an N-car (2-4) grid one tick. All entrants are typically human
   *  (inputs set externally); each drafts the car directly ahead. */
  private stepN(t: number): void {
    const st = this.state;
    for (const car of st.cars) {
      if (this.aiIds.has(car.id) && !car.finished) {
        updateAi(car, this.carAhead(car) ?? this.leaderCar(), this.track, this.rng, t, st.lapsTotal);
      }
    }
    for (const car of st.cars) {
      if (!car.finished) this.stepOne(car, this.carAhead(car), t);
    }
    st.time = t + SIM.DT;
    this.updateLateralN(SIM.DT);

    const order = this.computeOrder();
    if (order[0] !== this.leaderId && !st.cars.every((c) => c.finished)) {
      const leader = st.cars.find((c) => c.id === order[0])!;
      this.emit('overtake', order[0], { lap: leader.lap });
      this.leaderId = order[0];
    }
    // HUD reads gapSeconds as the local player's gap to the car directly ahead
    st.gapSeconds = this.gapToAhead(this.player);
    if (st.cars.every((c) => c.finished)) st.phase = 'finished';
  }

  /** the car physically just ahead of `car` on the road (nearest greater progress) */
  private carAhead(car: CarState): CarState | null {
    const myProg = this.progress(car);
    let best: CarState | null = null;
    let bestGap = Infinity;
    for (const o of this.state.cars) {
      if (o === car) continue;
      const d = this.progress(o) - myProg;
      if (d > 0 && d < bestGap) { bestGap = d; best = o; }
    }
    return best;
  }

  private leaderCar(): CarState {
    return this.state.cars.reduce((a, b) => (this.progress(b) > this.progress(a) ? b : a));
  }

  /** car ids ordered by track position, leader first */
  private computeOrder(): string[] {
    return this.state.cars
      .slice()
      .sort((a, b) => this.progress(b) - this.progress(a))
      .map((c) => c.id);
  }

  /** positive time gap from `car` back to the car directly ahead (0 if leading) */
  private gapToAhead(car: CarState): number {
    const ahead = this.carAhead(car);
    return ahead ? timeGapSeconds(car, ahead, this.track) : 0;
  }

  /** N-car lateral choreography: each car may pull alongside the car ahead; a
   *  final pass keeps every close pair laterally separated so none overlap. */
  private updateLateralN(dt: number): void {
    const cars = this.state.cars;
    for (const me of cars) {
      const ahead = this.carAhead(me);
      const cs = this.ctl[me.id];
      const delta = ahead ? sDelta(this.track, me.s, ahead.s) : Infinity; // >0: ahead is in front
      if (!cs.attacking) {
        if (ahead && delta > 0 && ((me.v > ahead.v + ATTACK_CLOSING_MS && delta <= ATTACK_RANGE_M) || delta <= PROX_RANGE_M)) {
          cs.attacking = true;
          cs.side = this.pickSide(me, ahead, delta);
        }
      } else if (!ahead || delta <= -CLEAR_AHEAD_M || delta > ATTACK_RANGE_M || (delta > PROX_EXIT_M && (!ahead || me.v <= ahead.v))) {
        cs.attacking = false;
      }
      const target = cs.attacking ? cs.side * ATTACK_OFFSET_M : 0;
      const step = LATERAL_EASE_RATE * dt;
      const diff = target - me.lateralOffset;
      me.lateralOffset += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
    }
    this.separateOverlaps();
  }

  /** Guarantee no two cars visually overlap: group cars by along-track
   *  proximity, then spread each clump into MIN_LATERAL_SEP-spaced lanes
   *  (recentred on the clump's mean so it stays on the road). One pass. */
  private separateOverlaps(): void {
    const cars = this.state.cars.filter((c) => !c.finished);
    const n = cars.length;
    if (n < 2) return;
    // union-find clumps of cars within OVERLAP_SPAN_M along the track
    const parent = cars.map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(sDelta(this.track, cars[i].s, cars[j].s)) < OVERLAP_SPAN_M) parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, CarState[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      const g = groups.get(r);
      if (g) g.push(cars[i]); else groups.set(r, [cars[i]]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => a.lateralOffset - b.lateralOffset);
      const meanBefore = g.reduce((s, c) => s + c.lateralOffset, 0) / g.length;
      for (let k = 1; k < g.length; k++) {
        const minPos = g[k - 1].lateralOffset + MIN_LATERAL_SEP_M;
        if (g[k].lateralOffset < minPos) g[k].lateralOffset = minPos;
      }
      // recentre the spaced clump on its original mean so it stays on-track
      const meanAfter = g.reduce((s, c) => s + c.lateralOffset, 0) / g.length;
      const shift = meanBefore - meanAfter;
      for (const c of g) c.lateralOffset += shift;
    }
  }

  private stepOne(car: CarState, other: CarState | null, t: number): void {
    const cs = this.ctl[car.id];
    const prevLap = car.lap;
    const prevArmed = car.energy.overrideArmed;

    // FIA C5.2.12 standing start: the MGU-K may not propel below 50 km/h on
    // the opening launch. Applied HERE (not in physics/energy) because it is
    // a race-launch rule, not lap state: effective deploy demand is zeroed by
    // forcing aggressiveness to 0 for the launch (zoneDeploy * 0 = 0 in
    // updateEnergy, which does NOT trip the superclip branch — that keys on
    // the raw map value), so the car launches on ICE torque alone until it
    // first reaches K_MIN_SPEED_STANDING_START.
    const launching = !cs.launchDone;
    const savedAggressiveness = car.inputs.aggressiveness;
    if (launching) car.inputs.aggressiveness = 0;
    stepCar(
      car,
      this.track,
      this.vLimit,
      { session: this.state.session, otherCar: other, raceTime: t },
      SIM.DT,
    );
    if (launching) {
      car.inputs.aggressiveness = savedAggressiveness;
      if (car.v >= PU.K_MIN_SPEED_STANDING_START) cs.launchDone = true;
    }

    if (car.lap > prevLap) this.onLapCrossing(car, prevLap, t);
    if (!car.finished) {
      if (!prevArmed && car.energy.overrideArmed) this.emit('override-armed', car.id);
      else if (prevArmed && !car.energy.overrideArmed) this.emit('override-expired', car.id);
      if (!cs.depleted && car.energy.soc < DEPLETED_SOC_FRAC * PU.ES_WINDOW) {
        cs.depleted = true;
        this.emit('energy-depleted', car.id, { lap: car.lap });
      }
    }
  }

  private onLapCrossing(car: CarState, prevLap: number, t: number): void {
    const cs = this.ctl[car.id];
    cs.depleted = false;
    if (prevLap === 0) {
      // The grid sits before the S/F line, so a car's first crossing only
      // STARTS lap 1 — drop the launch fragment stepCar recorded as a lap.
      car.lapTimes.pop();
      car.bestLap = null;
      return;
    }
    if (car.finished) return;
    const lapTime = car.lapTimes[car.lapTimes.length - 1];
    this.emit('lap-complete', car.id, { lap: prevLap, lapTime });

    // finish: first car to complete lapsTotal takes the flag; every other car
    // then finishes at its OWN next crossing, whatever its lap count. Ties on
    // the same tick resolve by fixed step order — deterministic. Generalized to
    // N cars: `winnerTime !== null` means someone has already taken the flag
    // (equivalent to the other car being finished in the 2-car case).
    if (prevLap >= this.state.lapsTotal || this.winnerTime !== null) {
      car.finished = true;
      // exact crossing time: end-of-tick time minus the overshoot past the line
      cs.finishTime = t + SIM.DT - car.currentLapTime;
      car.finishTime = cs.finishTime;
      if (this.winnerTime === null) {
        this.winnerTime = cs.finishTime;
        this.emit('finish', car.id, { gap: this.twoCar ? this.computeGap() : 0, laps: prevLap });
      } else {
        const margin = cs.finishTime - this.winnerTime; // seconds behind the winner
        if (this.twoCar) {
          const gap = car.id === 'player' ? margin : -margin; // player-minus-rival
          this.state.gapSeconds = gap;
          this.emit('finish', car.id, { gap, laps: prevLap });
        } else {
          this.emit('finish', car.id, { gap: margin, laps: prevLap });
        }
      }
    }
  }

  // -------------------------------------------------- lateral overtake anim

  /**
   * Visual-only lateral choreography (both cars use the same mechanism):
   * an attacker within ATTACK_RANGE_M and closing eases out to ±3.2 m on the
   * inside of the next corner (straights default left), holds the offset
   * while alongside, and eases back once CLEAR_AHEAD_M clear. A non-attacking
   * car that is overlapped holds its line (it may not ease into the
   * attacker), and a hard guard keeps |Δoffset| ≥ 2.8 m whenever |Δs| < 5.5 m
   * so the cars never visually occupy the same space.
   */
  private updateLateral(dt: number): void {
    const d = sDelta(this.track, this.rival.s, this.player.s); // >0: rival ahead
    const playerPrev = this.player.lateralOffset;
    const rivalPrev = this.rival.lateralOffset;
    this.lateralOne(this.player, this.rival, d, dt);
    this.lateralOne(this.rival, this.player, -d, dt);

    if (Math.abs(d) < OVERLAP_SPAN_M) {
      const sep = this.player.lateralOffset - this.rival.lateralOffset;
      if (Math.abs(sep) < MIN_LATERAL_SEP_M) {
        // hold the attacker's offset (the trailing car when states tie)
        const pAtt = this.ctl.player.attacking;
        const rAtt = this.ctl.rival.attacking;
        const attacker =
          pAtt && !rAtt ? this.player
          : rAtt && !pAtt ? this.rival
          : d > 0 ? this.player
          : this.rival;
        const other = attacker === this.player ? this.rival : this.player;
        attacker.lateralOffset = attacker === this.player ? playerPrev : rivalPrev;
        // last-resort clamp — unreachable in normal play, keeps the
        // no-overlap invariant absolute for every seed
        const sep2 = attacker.lateralOffset - other.lateralOffset;
        if (Math.abs(sep2) < MIN_LATERAL_SEP_M) {
          const sign = sep2 !== 0 ? Math.sign(sep2) : this.ctl[attacker.id].side;
          attacker.lateralOffset = other.lateralOffset + sign * MIN_LATERAL_SEP_M;
        }
      }
    }
  }

  /** delta > 0 means `other` is ahead of `me` along the track. */
  private lateralOne(me: CarState, other: CarState, delta: number, dt: number): void {
    const cs = this.ctl[me.id];
    if (!cs.attacking) {
      const closing = me.v > other.v + ATTACK_CLOSING_MS;
      if (delta > 0 && ((closing && delta <= ATTACK_RANGE_M) || delta <= PROX_RANGE_M)) {
        cs.attacking = true;
        cs.side = this.pickSide(me, other, delta);
      }
    } else if (
      delta <= -CLEAR_AHEAD_M ||
      delta > ATTACK_RANGE_M ||
      (delta > PROX_EXIT_M && me.v <= other.v)
    ) {
      cs.attacking = false;
    }
    // a non-attacking overlapped car keeps its line — never eases into the rival
    if (!cs.attacking && Math.abs(delta) < OVERLAP_SPAN_M) return;
    const target = cs.attacking ? cs.side * ATTACK_OFFSET_M : 0;
    const step = LATERAL_EASE_RATE * dt;
    const diff = target - me.lateralOffset;
    me.lateralOffset += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
  }

  /**
   * Attack side: the inside of the next corner — sign of the racing-line
   * curvature at its apex (kappa > 0 = left turn = inside on the left);
   * straights/negligible curvature default left. Two overrides, last wins:
   * a late entry already committed to a side stays there, and the attacker
   * never dives to a side the other car already occupies.
   */
  private pickSide(me: CarState, other: CarState, delta: number): 1 | -1 {
    const track = this.track;
    const corner = track.corners.find((c) => c.apexS > me.s) ?? track.corners[0];
    const n = this.line.kappa.length;
    const k = this.line.kappa[Math.round(corner.apexS / track.ds) % n];
    let side: 1 | -1 = k < -1e-4 ? -1 : 1;
    if (delta <= CLEAR_AHEAD_M && Math.abs(me.lateralOffset) > 1.5) {
      side = me.lateralOffset > 0 ? 1 : -1;
    }
    if (Math.abs(side * ATTACK_OFFSET_M - other.lateralOffset) < MIN_LATERAL_SEP_M) {
      side = side === 1 ? -1 : 1;
    }
    return side;
  }
}
