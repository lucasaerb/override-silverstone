/**
 * Broadcast-style DOM HUD overlay. Dark glass panels (see hud.css, linked
 * from index.html), laid out:
 *
 *  - bottom center: speed (km/h) + gear + deploy meter (green fill right of
 *    center for deploy 0->350 kW, blue fill growing leftward for harvest) +
 *    battery SoC bar with MJ / %.
 *  - bottom left: lap counter, live lap time, last lap, best lap (purple on
 *    a fresh personal best).
 *  - top center: position + gap to rival (red when losing, green gaining).
 *  - top right: OVERRIDE status chip (LOCKED / ELIGIBLE-in-Xm / ARMED /
 *    ACTIVE) + lap deploy energy vs the 8.0 MJ budget.
 *
 * update() reads ONLY the player car + gapSeconds. All per-frame writes are
 * cached-node textContent/style mutations that skip when unchanged; tabular
 * numerals in CSS keep the digits from jittering.
 */
import type { RaceState, TrackData } from '../sim/types';
import { PU, OVERRIDE } from '../sim/constants';
import { wrapS } from '../sim/track';

export interface HudHandle {
  update(state: RaceState, track: TrackData, solo?: boolean): void;
}

/** distance-to-detection-line window in which the chip shows ELIGIBLE, m */
const ELIGIBLE_WINDOW_M = 1200;

function fmtLapTime(t: number | null | undefined): string {
  if (t == null || !Number.isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export function createHud(container: HTMLElement): HudHandle {
  const root = document.createElement('div');
  root.className = 'hud';
  root.innerHTML = `
    <div class="hud-deploy-accent"></div>
    <div class="hud-deploy-badge">DEPLOY</div>
    <div class="hud-panel hud-top-center">
      <span class="hud-pos">P2</span>
      <span class="hud-gap-label">GAP</span>
      <span class="hud-gap">+0.000</span>
    </div>
    <div class="hud-top-right">
      <div class="hud-panel hud-ovr">
        <span class="hud-ovr-label">OVERRIDE</span>
        <span class="hud-ovr-chip is-locked">LOCKED</span>
      </div>
      <div class="hud-panel hud-lapenergy">
        <div class="hud-le-bar"><div class="hud-le-fill"></div></div>
        <span class="hud-le-txt">0.0 / 8.0 MJ</span>
      </div>
    </div>
    <div class="hud-panel hud-bottom-left">
      <div class="hud-row"><span class="hud-label">LAP</span><span class="hud-lap">1/5</span></div>
      <div class="hud-row"><span class="hud-label">TIME</span><span class="hud-cur">--:--.---</span></div>
      <div class="hud-row"><span class="hud-label">LAST</span><span class="hud-last">--:--.---</span></div>
      <div class="hud-row"><span class="hud-label">BEST</span><span class="hud-best">--:--.---</span></div>
    </div>
    <div class="hud-bottom-center">
      <div class="hud-panel hud-speedbox">
        <div class="hud-speed">0</div>
        <div class="hud-speed-unit">KM/H</div>
      </div>
      <div class="hud-panel hud-gearbox">
        <div class="hud-gear">1</div>
        <div class="hud-gear-lbl">GEAR</div>
      </div>
      <div class="hud-panel hud-energy">
        <div class="hud-deploy-row">
          <span class="hud-mini-label">MGU-K</span>
          <div class="hud-deploy-bar">
            <div class="hud-harvest-fill"></div>
            <div class="hud-deploy-fill"></div>
            <div class="hud-deploy-center"></div>
          </div>
          <span class="hud-kw">0 kW</span>
        </div>
        <div class="hud-deploy-row">
          <span class="hud-mini-label">ES</span>
          <div class="hud-soc-bar"><div class="hud-soc-fill"></div></div>
          <span class="hud-soc-txt">0.0 MJ &middot; 0%</span>
        </div>
      </div>
    </div>`;
  container.appendChild(root);

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`hud: missing node ${sel}`);
    return el;
  };
  const el = {
    accent: q('.hud-deploy-accent'),
    badge: q('.hud-deploy-badge'),
    energy: q('.hud-energy'),
    pos: q('.hud-pos'),
    gap: q('.hud-gap'),
    topCenter: q('.hud-top-center'),
    ovrBlock: q('.hud-ovr'),
    ovrChip: q('.hud-ovr-chip'),
    leFill: q('.hud-le-fill'),
    leTxt: q('.hud-le-txt'),
    lap: q('.hud-lap'),
    cur: q('.hud-cur'),
    last: q('.hud-last'),
    best: q('.hud-best'),
    speed: q('.hud-speed'),
    gear: q('.hud-gear'),
    deployFill: q('.hud-deploy-fill'),
    harvestFill: q('.hud-harvest-fill'),
    kw: q('.hud-kw'),
    socFill: q('.hud-soc-fill'),
    socTxt: q('.hud-soc-txt'),
  };

  // change-detection caches: no DOM writes unless a value actually moved
  const lastText = new Map<HTMLElement, string>();
  const setText = (node: HTMLElement, value: string): void => {
    if (lastText.get(node) !== value) {
      lastText.set(node, value);
      node.textContent = value;
    }
  };
  const lastClass = new Map<HTMLElement, string>();
  const setClass = (node: HTMLElement, base: string, mod: string): void => {
    const cls = `${base} ${mod}`;
    if (lastClass.get(node) !== cls) {
      lastClass.set(node, cls);
      node.className = cls;
    }
  };
  const lastWidth = new Map<HTMLElement, number>();
  const setWidthPct = (node: HTMLElement, pct: number): void => {
    const w = Math.round(pct * 10) / 10;
    if (lastWidth.get(node) !== w) {
      lastWidth.set(node, w);
      node.style.width = `${w}%`;
    }
  };

  let prevGap: number | null = null;
  let gapTrend = 0; // smoothed d(gap)/frame: negative = player gaining
  // EMA of MGU-K power so the meter shows net flow, not the per-tick chatter the
  // bang-bang controller produces at corner speed limits (see telemetry.ts).
  let smoothPw = 0;
  let lastEmaMs = 0;

  return {
    update(state: RaceState, track: TrackData, solo?: boolean): void {
      const player = state.cars.find((c) => c.id === 'player');
      if (!player) return;

      // solo modes (time trial / optimal) have no rival — hide the gap/position
      // and Override eligibility, which would otherwise read against a parked car
      // (the writes below still run but target now-hidden nodes, which is fine)
      el.topCenter.style.display = solo ? 'none' : '';
      el.ovrBlock.style.display = solo ? 'none' : '';

      // ---- top center: position + gap
      const gap = state.gapSeconds;
      setText(el.pos, gap < 0 ? 'P1' : 'P2');
      if (prevGap != null) gapTrend += (gap - prevGap - gapTrend) * 0.05;
      prevGap = gap;
      setText(el.gap, `${gap >= 0 ? '+' : '-'}${Math.abs(gap).toFixed(3)}`);
      setClass(el.gap, 'hud-gap', gapTrend < -0.00002 ? 'is-gaining' : gapTrend > 0.00002 ? 'is-losing' : 'is-flat');

      // ---- top right: override chip + lap energy. Wording teaches the state:
      //   ACTIVE (striking) → ARMED (ready, hold SPACE) → IN RANGE (within the
      //   1.0s detection gap, will arm at the line) → GAP x.xs (behind, too far)
      //   → LEADING (no car ahead to chase) → LOCKED (line not near).
      const en = player.energy; // gap (player − rival; >0 = a car is ahead) from above
      if (en.overrideActive) {
        setText(el.ovrChip, 'ACTIVE');
        setClass(el.ovrChip, 'hud-ovr-chip', 'is-active');
      } else if (en.overrideArmed) {
        setText(el.ovrChip, 'ARMED');
        setClass(el.ovrChip, 'hud-ovr-chip', 'is-armed');
      } else {
        const dist = wrapS(track, track.detectionLineS - player.s);
        const near = dist < ELIGIBLE_WINDOW_M;
        if (gap > 0 && gap < OVERRIDE.DETECTION_GAP) {
          setText(el.ovrChip, `IN RANGE ${gap.toFixed(1)}s`);
          setClass(el.ovrChip, 'hud-ovr-chip', 'is-eligible');
        } else if (gap > 0) {
          setText(el.ovrChip, near ? `NEED <1.0s (${gap.toFixed(1)})` : `GAP ${gap.toFixed(1)}s`);
          setClass(el.ovrChip, 'hud-ovr-chip', 'is-locked');
        } else {
          setText(el.ovrChip, 'LEADING');
          setClass(el.ovrChip, 'hud-ovr-chip', 'is-leading');
        }
      }
      const budget = PU.HARVEST_CAP_RACE; // 8.0 MJ per-lap deploy budget
      setWidthPct(el.leFill, Math.min(100, (en.deployedThisLap / budget) * 100));
      setText(el.leTxt, `${(en.deployedThisLap / 1e6).toFixed(1)} / ${(budget / 1e6).toFixed(1)} MJ`);

      // ---- bottom left: laps + times
      setText(el.lap, `${Math.min(player.lap, state.lapsTotal)}/${state.lapsTotal}`);
      setText(el.cur, fmtLapTime(player.currentLapTime));
      const lastLap = player.lapTimes.length > 0 ? player.lapTimes[player.lapTimes.length - 1] : null;
      setText(el.last, fmtLapTime(lastLap));
      setText(el.best, fmtLapTime(player.bestLap));
      // purple when the last completed lap IS the personal best
      const isPb = lastLap != null && player.bestLap != null && lastLap === player.bestLap;
      setClass(el.best, 'hud-best', isPb ? 'is-pb' : 'is-plain');

      // ---- bottom center: speed / gear / deploy meter / SoC
      setText(el.speed, String(Math.round(player.v * 3.6)));
      setText(el.gear, String(player.gear));
      const pwRaw = player.deployPowerW;
      const nowMs = performance.now();
      const dtMs = lastEmaMs ? Math.min(250, nowMs - lastEmaMs) : 16;
      lastEmaMs = nowMs;
      smoothPw += (pwRaw - smoothPw) * (1 - Math.exp(-dtMs / 350));
      const pw = smoothPw; // meter + kW read the net flow (no corner strobing)
      const frac = Math.min(1, Math.abs(pw) / PU.K_POWER);
      if (pw >= 0) {
        setWidthPct(el.deployFill, frac * 50);
        setWidthPct(el.harvestFill, 0);
      } else {
        setWidthPct(el.deployFill, 0);
        setWidthPct(el.harvestFill, frac * 50);
      }
      const kwTxt = `${pw < 0 ? '-' : ''}${Math.round(Math.abs(pw) / 1e3)} kW`;
      setText(el.kw, kwTxt);
      setClass(el.kw, 'hud-kw', pw < -1000 ? 'is-harvest' : 'is-deploy');
      const socFrac = Math.max(0, Math.min(1, en.soc / PU.ES_WINDOW));
      setWidthPct(el.socFill, socFrac * 100);
      setText(el.socTxt, `${(en.soc / 1e6).toFixed(1)} MJ · ${Math.round(socFrac * 100)}%`);
      setClass(el.socFill, 'hud-soc-fill', socFrac < 0.2 ? 'is-low' : 'is-ok');

      // ---- DEPLOY cue: make holding SPACE feel physical. Screen-edge accent +
      // a DEPLOY badge over the speed box + the kW meter pulsing. Override boost
      // reads green; plain manual push-to-pass reads papaya.
      const manualDeploy = player.inputs.boostHeld && pwRaw > 0 && !en.overrideActive;
      if (en.overrideActive) {
        setClass(el.accent, 'hud-deploy-accent', 'is-override');
        setClass(el.badge, 'hud-deploy-badge', 'is-override is-on');
        setText(el.badge, 'OVERRIDE');
        setClass(el.energy, 'hud-panel hud-energy', 'is-override');
        setClass(el.kw, 'hud-kw', 'is-deploy is-boostpulse');
      } else if (manualDeploy) {
        setClass(el.accent, 'hud-deploy-accent', 'is-manual');
        setClass(el.badge, 'hud-deploy-badge', 'is-manual is-on');
        setText(el.badge, 'DEPLOY');
        setClass(el.energy, 'hud-panel hud-energy', 'is-boosting');
        setClass(el.kw, 'hud-kw', 'is-deploy is-boostpulse');
      } else {
        setClass(el.accent, 'hud-deploy-accent', '');
        setClass(el.badge, 'hud-deploy-badge', '');
        setClass(el.energy, 'hud-panel hud-energy', '');
        // kw class already set above by the deploy/harvest branch
      }
    },
  };
}
