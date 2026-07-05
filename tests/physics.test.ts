import { describe, expect, it } from 'vitest';
import { CAR, PU, SIM, deployCapNormalW } from '../src/sim/constants';
import { computeVLimit, stepCar, timeGapSeconds, type StepCtx } from '../src/sim/physics';
import { Rng } from '../src/sim/rng';
import { makeCar, makeSyntheticTrack } from './synthetic';

const DT = SIM.DT;

function ctx(session: 'race' | 'quali', otherCar = null as StepCtx['otherCar']): StepCtx {
  return { session, otherCar, raceTime: 0 };
}

describe('computeVLimit', () => {
  it('caps corner speed by downforce-aware grip and 100 m/s elsewhere', () => {
    const track = makeSyntheticTrack({ kind: 'stadium', straight: 700, radius: 60 });
    const vLimit = computeVLimit(track);
    // closed form at R=60: v^2 = mu m g / (m/R - mu 0.5 rho ClA)
    const denom = CAR.MASS / 60 - CAR.TIRE_MU * 0.5 * CAR.RHO_AIR * CAR.CLA_Z;
    const vCorner = Math.sqrt((CAR.TIRE_MU * CAR.MASS * CAR.G) / denom);
    const apexIdx = Math.round((700 + (Math.PI * 60) / 2) / track.ds);
    expect(vLimit[apexIdx]).toBeCloseTo(vCorner, 1);
    expect(vLimit[Math.round(100 / track.ds)]).toBeLessThanOrEqual(100);
    // backward pass: profile descends toward the corner along the straight
    const cornerStartIdx = Math.floor(700 / track.ds);
    expect(vLimit[cornerStartIdx - 10]).toBeGreaterThan(vLimit[cornerStartIdx]);
    expect(vLimit[cornerStartIdx - 10]).toBeLessThan(vLimit[cornerStartIdx - 40]);
  });

  it('converges across the start/finish wrap', () => {
    // corner-2 ends at the line, so sample 0 sits at corner speed and the
    // wrap must pull late-lap samples down, not leave them at 100
    const track = makeSyntheticTrack({ kind: 'stadium', straight: 700, radius: 60 });
    const vLimit = computeVLimit(track);
    expect(vLimit[vLimit.length - 1]).toBeLessThan(50);
  });
});

describe('straight-line performance', () => {
  it('terminal velocity in X-mode without deploy lands in the drag-limited band', () => {
    const track = makeSyntheticTrack({ kind: 'circle', radius: 3000 });
    const vLimit = computeVLimit(track);
    // empty battery + nonzero zoneDeploy: no deploy and no superclip -> pure ICE
    const car = makeCar('player', track, { v: 50 });
    car.energy.soc = 0;
    const c = ctx('quali');
    let prev = 0;
    for (let t = 0; t < 60 / DT; t++) {
      if (t === Math.floor(58 / DT)) prev = car.v;
      stepCar(car, track, vLimit, c, DT);
    }
    expect(car.aeroMode).toBe('X');
    expect(car.deployPowerW).toBe(0);
    expect(car.v - prev).toBeLessThan(0.05); // settled
    expect(car.v).toBeGreaterThan(86);
    expect(car.v).toBeLessThan(96);
  });

  it('deploy power sits exactly on the normal taper at 290/320/340/345 in a quasi-static sweep', () => {
    // scripted 2 km/h/s speed ramp: the taper never falls faster than
    // 40 kW/s, so the 50 kW/s clip floor never binds and deployPowerW must
    // track deployCapNormalW exactly through every taper leg
    const track = makeSyntheticTrack({ kind: 'circle', radius: 3000 });
    const vLimit = computeVLimit(track);
    // full throttle: deploy scales with throttle, so pin it at 1 to isolate the
    // speed taper (the driver is flat-out on this straight-equivalent circle)
    const car = makeCar('player', track, { v: 285 / 3.6, throttle: 1 });
    const c = ctx('quali');
    const atSpeed = new Map<number, number>();
    const thresholds = [290, 320, 340, 345];
    for (let t = 0; t < 40 / DT; t++) {
      const vKmh = 285 + 2 * t * DT;
      car.v = vKmh / 3.6;
      car.energy.soc = PU.ES_WINDOW; // scripted: keep the battery out of the way
      stepCar(car, track, vLimit, c, DT);
      for (const th of thresholds) {
        if (!atSpeed.has(th) && vKmh >= th) atSpeed.set(th, car.deployPowerW);
      }
      expect(car.deployPowerW).toBeCloseTo(deployCapNormalW(vKmh), -3);
    }
    expect(atSpeed.get(290)!).toBeCloseTo(350e3, -3);
    expect(atSpeed.get(320)!).toBeCloseTo(200e3, -3);
    expect(atSpeed.get(340)!).toBeCloseTo(100e3, -3);
    expect(atSpeed.get(345)!).toBeCloseTo(0, -3);
  });

  it('full-deploy acceleration follows the taper under the 50 kW/s clip rule and dies past 345', () => {
    // free-running full-deploy X-mode gains speed faster than 10 km/h/s, so
    // the -5 kW/kmh taper leg falls faster than RAMP_DOWN_LIMIT allows and
    // deploy must ride the clip floor: p == max(taper(v), lastP - 50 kW/s dt)
    const track = makeSyntheticTrack({ kind: 'circle', radius: 3000 });
    const vLimit = computeVLimit(track);
    const car = makeCar('player', track, { v: 80, throttle: 1 });
    // phantom tow car pinned 30 m ahead above ~330 km/h so the drag-limited
    // car (clean-air terminal ~340 km/h) can push through 345
    const hare = makeCar('rival', track);
    let crossed290 = 0;
    let at340 = -1;
    let at345 = -1;
    for (let t = 0; t < 40 / DT; t++) {
      hare.s = (car.s + 30) % track.length;
      hare.v = car.v;
      const vBefore = car.v;
      const lastP = car.deployPowerW;
      stepCar(car, track, vLimit, ctx('quali', vBefore >= 91.5 ? hare : null), DT);
      const expected = Math.min(
        PU.K_POWER,
        Math.max(deployCapNormalW(vBefore * 3.6), lastP - PU.RAMP_DOWN_LIMIT * DT),
      );
      expect(car.deployPowerW).toBeCloseTo(Math.max(0, expected), 0);
      if (vBefore * 3.6 <= 290) crossed290 = t;
      if (at340 < 0 && car.v * 3.6 >= 340) at340 = car.deployPowerW;
      if (at345 < 0 && car.v * 3.6 >= 345) at345 = car.deployPowerW;
      if (car.deployPowerW === 0 && car.v * 3.6 > 345) break;
    }
    expect(crossed290).toBeGreaterThan(0); // sweep really started below 290
    expect(car.inTow).toBe(true);
    expect(at345).toBeGreaterThanOrEqual(0);
    expect(at340).toBeLessThan(200e3); // clip tail well below full power by 340
    expect(at345).toBeLessThan(at340); // still bleeding down at the 50 kW/s rate
    expect(car.v * 3.6).toBeGreaterThan(345); // tow carries it past the normal-mode cutoff
    expect(car.deployPowerW).toBe(0); // deploy fully clipped away above 345
  });
});

describe('cornering and braking', () => {
  const track = makeSyntheticTrack({ kind: 'stadium', straight: 700, radius: 60 });
  const vLimit = computeVLimit(track);
  const piR = Math.PI * 60;

  function runLaps(laps: number) {
    const car = makeCar('player', track);
    const c = ctx('quali');
    const apexS = 700 + piR / 2;
    const apexIdx = Math.round(apexS / track.ds);
    const apexV: number[] = [];
    const brakeS: number[] = [];
    const lapSnapshots: Array<{ lapTime: number; sectors: number[] }> = [];
    let sawXOnStraight = false;
    let sawZInCorner = false;
    for (let t = 0; t < 300 / DT && car.lap < laps; t++) {
      const prevS = car.s;
      const prevLaps = car.lapTimes.length;
      stepCar(car, track, vLimit, c, DT);
      if (prevS < apexS && car.s >= apexS) apexV.push(car.v);
      if (car.brake > 0 && car.lap >= 1) brakeS.push(prevS);
      if (car.lap >= 1 && car.throttle >= 1 && car.s > 200 && car.s < 600) {
        sawXOnStraight ||= car.aeroMode === 'X';
      }
      if (car.s > 700 + 0.3 * piR && car.s < 700 + 0.7 * piR) {
        sawZInCorner ||= car.aeroMode === 'Z';
      }
      if (car.lapTimes.length > prevLaps) {
        lapSnapshots.push({
          lapTime: car.lapTimes[car.lapTimes.length - 1],
          sectors: [...car.currentSectors],
        });
      }
    }
    return { car, apexV, brakeS, lapSnapshots, apexIdx, sawXOnStraight, sawZInCorner };
  }

  it('respects vLimit at the apex and brakes before the corner, not in it', () => {
    const { apexV, brakeS, apexIdx, sawXOnStraight, sawZInCorner } = runLaps(3);
    expect(apexV.length).toBeGreaterThanOrEqual(3);
    for (const v of apexV) expect(v).toBeLessThanOrEqual(vLimit[apexIdx] + 0.5);
    // braking exists on the approach straight...
    expect(brakeS.some((s) => s > 400 && s < 700)).toBe(true);
    // ...and never in the middle of the semicircle
    expect(brakeS.some((s) => s > 700 + 0.25 * piR && s < 700 + 0.75 * piR)).toBe(false);
    expect(sawXOnStraight).toBe(true);
    expect(sawZInCorner).toBe(true);
  });

  it('laps are timed and sector times sum to the lap time', () => {
    const { car, lapSnapshots } = runLaps(3);
    expect(car.lapTimes.length).toBeGreaterThanOrEqual(3);
    expect(car.bestLap).toBe(Math.min(...car.lapTimes));
    // skip lap 1 (standing start settles mid-lap); later laps have 3 sectors
    for (const snap of lapSnapshots.slice(1)) {
      expect(snap.sectors).toHaveLength(3);
      const sum = snap.sectors[0] + snap.sectors[1] + snap.sectors[2];
      expect(sum).toBeCloseTo(snap.lapTime, 6);
      for (const s of snap.sectors) expect(s).toBeGreaterThan(0);
    }
  });
});

describe('timeGapSeconds', () => {
  const track = makeSyntheticTrack({ kind: 'stadium', straight: 700, radius: 60 });

  it('divides arc distance ahead by the chaser speed with a 20 m/s floor', () => {
    const behind = makeCar('player', track, { s: 100, v: 50 });
    const ahead = makeCar('rival', track, { s: 200, v: 50 });
    expect(timeGapSeconds(behind, ahead, track)).toBeCloseTo(2, 6);
    behind.v = 5;
    expect(timeGapSeconds(behind, ahead, track)).toBeCloseTo(100 / 20, 6);
  });

  it('handles the lap wrap', () => {
    const behind = makeCar('player', track, { s: track.length - 40, v: 40 });
    const ahead = makeCar('rival', track, { s: 40, v: 40 });
    expect(timeGapSeconds(behind, ahead, track)).toBeCloseTo(80 / 40, 6);
  });
});

describe('determinism', () => {
  it('two identical two-car sims agree exactly after 10,000 ticks', () => {
    function run(): string {
      const track = makeSyntheticTrack({ kind: 'stadium', straight: 700, radius: 60 });
      const vLimit = computeVLimit(track);
      const rng = new Rng(7);
      const player = makeCar('player', track, { v: 60 });
      const rival = makeCar('rival', track, { s: 60, v: 60 });
      for (const car of [player, rival]) {
        car.deployMap.zoneDeploy = track.zones.map(() => (rng.next() < 0.3 ? 0 : 1));
        car.deployMap.zoneLift = track.zones.map(() => rng.range(0, 1));
      }
      player.inputs.boostHeld = true;
      for (let t = 0; t < 10_000; t++) {
        const raceTime = t * DT;
        stepCar(player, track, vLimit, { session: 'race', otherCar: rival, raceTime }, DT);
        stepCar(rival, track, vLimit, { session: 'race', otherCar: player, raceTime }, DT);
      }
      for (const car of [player, rival]) {
        expect(Number.isFinite(car.v)).toBe(true);
        expect(Number.isFinite(car.s)).toBe(true);
        expect(Number.isFinite(car.energy.soc)).toBe(true);
      }
      return JSON.stringify([player, rival]);
    }
    expect(run()).toBe(run());
  });
});
