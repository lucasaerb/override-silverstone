/**
 * Live race-engineer telemetry panel — a DOM overlay that sits at the right
 * edge and TEACHES the energy-deployment game while showing it happen. It is
 * the counterpart to the broadcast HUD (hud.ts): the HUD is the glanceable
 * dashboard, this is the deep instrument stack.
 *
 * Design mirrors hud.ts: DOM text nodes are cached and only mutated when a
 * value actually changes (setText / setClass / setWidth), tabular numerals in
 * CSS keep the digits from dancing. The one live drawing surface is a small
 * DPR-aware canvas showing a rolling ~12 s speed trace with a faint MGU-K
 * power overlay, so the player SEES deploy → speed.
 *
 * Content (top → bottom):
 *  - DEPLOY MODE headline — the state machine that makes SPACE feel alive:
 *    OVERRIDE BOOST / MANUAL DEPLOY / AUTO·MAP / HARVESTING / COASTING.
 *  - MGU-K power flow with the speed taper CEILING drawn on the bar (teaches
 *    the 290 km/h taper and the higher Override ceiling).
 *  - rolling 12 s speed trace + power overlay canvas.
 *  - battery (ES) SoC + per-lap deployed / harvested vs the 8.0 MJ budget.
 *  - Manual Override explainer — the 1.0 s detection-gap rule, live.
 *  - tow / throttle / brake.
 *  - per-sector splits.
 *  - a compact deployment legend (also shown when collapsed with T).
 *
 * The whole panel lives inside raceUi, so it inherits race-only visibility;
 * `setVisible` and `toggle` (bound to the T key) layer on top of that.
 */
import type { RaceState, TrackData } from '../sim/types';
import { PU, OVERRIDE, deployCapNormalW, deployCapOverrideW } from '../sim/constants';
import { wrapS } from '../sim/track';

export interface TelemetryHandle {
  update(state: RaceState, track: TrackData, solo?: boolean, localId?: string): void;
  setVisible(visible: boolean): void;
  /** flip the detailed panel; returns the new detail-visible state */
  toggle(): boolean;
  /** clear the rolling trace + timing caches (new race) */
  reset(): void;
}

/** rolling speed-trace window, ms */
const TRACE_MS = 12_000;
/** trace sample cadence — one point + one canvas redraw per this many ms */
const SAMPLE_MS = 50;
/** trace vertical scale: km/h at the top of the graph */
const TRACE_TOP_KMH = 360;

function fmtSec(t: number | undefined): string {
  return t == null || !Number.isFinite(t) ? '--.--' : t.toFixed(2);
}

export function createTelemetry(container: HTMLElement): TelemetryHandle {
  const root = document.createElement('div');
  root.className = 'tel';
  root.innerHTML = `
    <div class="tel-headbar">
      <span class="tel-title">RACE ENGINEER</span>
      <span class="tel-keyhint">T</span>
    </div>

    <div class="tel-mode is-coast">
      <div class="tel-mode-chip">COASTING</div>
      <div class="tel-mode-sub">no energy flow</div>
    </div>

    <div class="tel-detail">
      <div class="tel-block">
        <div class="tel-lblrow"><span class="tel-lbl">MGU-K POWER</span><span class="tel-pw-kw is-deploy">0 kW</span></div>
        <div class="tel-pw-bar">
          <div class="tel-pw-harvest"></div>
          <div class="tel-pw-deploy"></div>
          <div class="tel-pw-cap"></div>
          <div class="tel-pw-center"></div>
        </div>
        <div class="tel-cap-txt">350 kW rated &middot; cap 350 kW @ 0 km/h</div>
      </div>

      <div class="tel-block">
        <div class="tel-lblrow"><span class="tel-lbl">SPEED &middot; LAST 12s</span><span class="tel-trace-v">0 km/h</span></div>
        <canvas class="tel-trace"></canvas>
      </div>

      <div class="tel-block">
        <div class="tel-lblrow"><span class="tel-lbl">BATTERY &middot; ENERGY STORE</span><span class="tel-soc">0.0 MJ &middot; 0%</span></div>
        <div class="tel-soc-bar"><div class="tel-soc-fill"></div></div>
        <div class="tel-le-grid">
          <div class="tel-le-cell"><span class="tel-le-num tel-dep">0.0</span><span class="tel-le-u">DEPLOYED MJ</span></div>
          <div class="tel-le-cell"><span class="tel-le-num tel-har">0.0</span><span class="tel-le-u">HARVESTED MJ</span></div>
          <div class="tel-le-cell"><span class="tel-le-num">8.0</span><span class="tel-le-u">LAP BUDGET</span></div>
        </div>
        <div class="tel-budget-bar"><div class="tel-budget-fill"></div><div class="tel-budget-harv"></div></div>
      </div>

      <div class="tel-block tel-ovr is-locked">
        <div class="tel-lblrow"><span class="tel-lbl">MANUAL OVERRIDE</span><span class="tel-ovr-state">LOCKED</span></div>
        <div class="tel-ovr-explain">Get within 1.0s of the car ahead at the detection line to unlock.</div>
        <div class="tel-gap-bar"><div class="tel-gap-fill"></div><div class="tel-gap-thresh"></div></div>
        <div class="tel-ovr-detail">gap --.--s / 1.00s &middot; detection --- m</div>
      </div>

      <div class="tel-block tel-inputs">
        <div class="tel-tow is-off">CLEAN AIR</div>
        <div class="tel-tb">
          <span class="tel-tb-lbl">THR</span>
          <div class="tel-tb-bar"><div class="tel-thr-fill"></div></div>
          <span class="tel-tb-lbl">BRK</span>
          <div class="tel-tb-bar"><div class="tel-brk-fill"></div></div>
        </div>
      </div>

      <div class="tel-block tel-sectors">
        <div class="tel-sec" data-s="1"><span class="tel-sec-lbl">S1</span><span class="tel-sec-t">--.--</span></div>
        <div class="tel-sec" data-s="2"><span class="tel-sec-lbl">S2</span><span class="tel-sec-t">--.--</span></div>
        <div class="tel-sec" data-s="3"><span class="tel-sec-lbl">S3</span><span class="tel-sec-t">--.--</span></div>
      </div>
    </div>

    <div class="tel-legend">
      <div class="tel-leg-row"><span class="tel-key">SPACE</span> deploy — push-to-pass, drains battery</div>
      <div class="tel-leg-row"><span class="tel-dot d-taper"></span> power tapers past 290 km/h, zero by 345</div>
      <div class="tel-leg-row"><span class="tel-dot d-ovr"></span> within 1.0s of the car ahead unlocks OVERRIDE</div>
      <div class="tel-leg-row"><span class="tel-dot d-harv"></span> harvest under braking &middot; 8.0 MJ / lap budget</div>
      <div class="tel-leg-row tel-leg-keys"><span class="tel-key">T</span> telemetry &middot; <span class="tel-key">M</span> map &middot; <span class="tel-key">&uarr;&darr;</span> trim</div>
    </div>`;
  container.appendChild(root);

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`telemetry: missing node ${sel}`);
    return el;
  };
  const el = {
    mode: q('.tel-mode'),
    modeChip: q('.tel-mode-chip'),
    modeSub: q('.tel-mode-sub'),
    pwKw: q('.tel-pw-kw'),
    pwDeploy: q('.tel-pw-deploy'),
    pwHarvest: q('.tel-pw-harvest'),
    pwCap: q('.tel-pw-cap'),
    capTxt: q('.tel-cap-txt'),
    traceV: q('.tel-trace-v'),
    trace: q<HTMLCanvasElement>('.tel-trace'),
    soc: q('.tel-soc'),
    socFill: q('.tel-soc-fill'),
    dep: q('.tel-dep'),
    har: q('.tel-har'),
    budgetFill: q('.tel-budget-fill'),
    budgetHarv: q('.tel-budget-harv'),
    ovr: q('.tel-ovr'),
    ovrState: q('.tel-ovr-state'),
    ovrExplain: q('.tel-ovr-explain'),
    ovrDetail: q('.tel-ovr-detail'),
    gapFill: q('.tel-gap-fill'),
    tow: q('.tel-tow'),
    thrFill: q('.tel-thr-fill'),
    brkFill: q('.tel-brk-fill'),
    secT: Array.from(root.querySelectorAll<HTMLElement>('.tel-sec-t')),
    sec: Array.from(root.querySelectorAll<HTMLElement>('.tel-sec')),
  };
  const traceCtx = el.trace.getContext('2d');

  // -- change-detection caches (no DOM write unless a value moved)
  const lastText = new Map<HTMLElement, string>();
  const setText = (node: HTMLElement, value: string): void => {
    if (lastText.get(node) !== value) { lastText.set(node, value); node.textContent = value; }
  };
  const lastClass = new Map<HTMLElement, string>();
  const setClass = (node: HTMLElement, base: string, mod: string): void => {
    const cls = mod ? `${base} ${mod}` : base;
    if (lastClass.get(node) !== cls) { lastClass.set(node, cls); node.className = cls; }
  };
  // each node is only ever driven with one style prop, so a single cache is safe
  const lastNum = new Map<HTMLElement, number>();
  const setStyle = (node: HTMLElement, prop: 'width' | 'left', pct: number): void => {
    const v = Math.round(pct * 10) / 10;
    if (lastNum.get(node) !== v) { lastNum.set(node, v); node.style[prop] = `${v}%`; }
  };

  // -- rolling trace ring buffer, wall-clock timed
  const traceT: number[] = [];
  const traceV: number[] = [];
  const traceP: number[] = [];
  let traceW = 0;
  let traceH = 0;
  let traceDpr = 1;
  let prevSimTime = 0;
  let lastSampleT = 0;

  const clearTrace = (): void => {
    traceT.length = 0; traceV.length = 0; traceP.length = 0; lastSampleT = 0;
  };

  const sizeTrace = (): void => {
    const cssW = el.trace.clientWidth || 264;
    const cssH = el.trace.clientHeight || 56;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cssW === traceW && cssH === traceH && dpr === traceDpr) return;
    traceW = cssW; traceH = cssH; traceDpr = dpr;
    el.trace.width = Math.round(cssW * dpr);
    el.trace.height = Math.round(cssH * dpr);
  };

  const drawTrace = (): void => {
    const g = traceCtx;
    if (!g) return;
    sizeTrace();
    const w = traceW, h = traceH;
    g.save();
    g.scale(traceDpr, traceDpr);
    g.clearRect(0, 0, w, h);

    // faint horizontal gridlines at 100 / 200 / 300 km/h
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    for (const kmh of [100, 200, 300]) {
      const y = h - (kmh / TRACE_TOP_KMH) * h + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }

    const now = performance.now();
    const t0 = now - TRACE_MS;
    const px = (t: number): number => ((t - t0) / TRACE_MS) * w;
    const spdY = (v: number): number => h - Math.min(1, (v * 3.6) / TRACE_TOP_KMH) * h;

    if (traceT.length >= 2) {
      // power activity area under the trace (faint): papaya deploy, teal harvest
      const powH = h * 0.5;
      for (let i = 1; i < traceT.length; i++) {
        const p = traceP[i];
        if (Math.abs(p) < 3000) continue;
        const x0 = px(traceT[i - 1]);
        const x1 = px(traceT[i]);
        const mag = Math.min(1, Math.abs(p) / PU.K_POWER);
        g.fillStyle = p >= 0 ? 'rgba(255,132,18,0.22)' : 'rgba(42,182,176,0.20)';
        g.fillRect(x0, h - mag * powH, Math.max(1, x1 - x0 + 0.6), mag * powH);
      }
      // speed line
      g.beginPath();
      for (let i = 0; i < traceT.length; i++) {
        const x = px(traceT[i]);
        const y = spdY(traceV[i]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = '#ffd043';
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.stroke();
      // leading dot
      const lx = px(traceT[traceT.length - 1]);
      const ly = spdY(traceV[traceV.length - 1]);
      g.beginPath(); g.arc(lx, ly, 2.6, 0, Math.PI * 2);
      g.fillStyle = '#fff'; g.fill();
    } else {
      g.fillStyle = 'rgba(255,255,255,0.28)';
      g.font = '10px ui-sans-serif, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('gathering data…', w / 2, h / 2);
    }
    g.restore();
  };

  let detail = true;
  let visible = false;

  // -- deploy-power display smoothing. The bang-bang driver controller chatters
  // throttle<->coast/brake at the corner speed limit, so the raw per-tick power
  // flips sign ~10x/s in slow corners. We classify the MODE headline and drive
  // the kW readout from a short EMA (net power over ~0.35 s) with hysteresis, so
  // it shows the genuine dominant state instead of strobing — like real telemetry.
  let smoothPw = 0;
  let lastEmaMs = 0;
  type PwMode = 'override' | 'manual' | 'auto' | 'harvest' | 'coast';
  let pwMode: PwMode = 'coast';
  const EMA_TAU_MS = 350;
  const ENTER_W = 20_000; // net power to switch into deploy/harvest
  const EXIT_W = 8_000; // ...and to fall back to coasting (hysteresis)

  return {
    setVisible(v: boolean): void {
      if (v === visible) return;
      visible = v;
      root.style.display = v ? 'flex' : 'none';
    },

    toggle(): boolean {
      detail = !detail;
      root.classList.toggle('is-collapsed', !detail);
      if (detail && visible) drawTrace(); // repaint the retained-mode canvas at once
      return detail;
    },

    reset(): void {
      clearTrace();
      prevSimTime = 0;
      smoothPw = 0;
      lastEmaMs = 0;
      pwMode = 'coast';
    },

    update(state: RaceState, track: TrackData, solo?: boolean, localId?: string): void {
      const p = state.cars.find((c) => c.id === (localId ?? 'player'));
      if (!p) return;
      // solo modes have no rival — hide the Manual Override / tow blocks
      el.ovr.style.display = solo ? 'none' : '';
      el.tow.style.display = solo ? 'none' : '';
      const en = p.energy;
      const pw = p.deployPowerW;
      const vKmh = p.v * 3.6;

      // auto-reset the trace when a fresh race rewinds sim time
      if (state.time < prevSimTime - 0.1) { clearTrace(); smoothPw = 0; pwMode = 'coast'; }
      prevSimTime = state.time;

      // ---- EMA-smooth the deploy power (kills corner chatter in the display)
      const nowMs = performance.now();
      const dtMs = lastEmaMs ? Math.min(250, nowMs - lastEmaMs) : 16;
      lastEmaMs = nowMs;
      smoothPw += (pw - smoothPw) * (1 - Math.exp(-dtMs / EMA_TAU_MS));

      // ---- DEPLOY MODE headline, from the net (smoothed) power with hysteresis
      if (en.overrideActive) pwMode = 'override';
      else if (p.inputs.boostHeld && smoothPw > 0) pwMode = 'manual';
      else if (pwMode === 'auto') { if (smoothPw < EXIT_W) pwMode = smoothPw < -ENTER_W ? 'harvest' : 'coast'; }
      else if (pwMode === 'harvest') { if (smoothPw > -EXIT_W) pwMode = smoothPw > ENTER_W ? 'auto' : 'coast'; }
      else { // coast, or leaving override/manual
        if (smoothPw > ENTER_W) pwMode = 'auto';
        else if (smoothPw < -ENTER_W) pwMode = 'harvest';
        else pwMode = 'coast';
      }
      const MODE_UI: Record<PwMode, [string, string, string]> = {
        override: ['is-override', 'OVERRIDE BOOST', 'attack mode — full power to 337 km/h'],
        manual: ['is-manual', 'MANUAL DEPLOY', 'SPACE held — push-to-pass, draining ES'],
        auto: ['is-auto', 'AUTO · MAP', 'strategy map is deploying here'],
        harvest: ['is-harvest', 'HARVESTING', 'recovering energy into the battery'],
        coast: ['is-coast', 'COASTING', p.inputs.boostHeld && en.soc <= 1 ? 'battery empty — nothing to deploy' : 'grip-limited — little energy flow'],
      };
      const [mMod, mChip, mSub] = MODE_UI[pwMode];
      setClass(el.mode, 'tel-mode', mMod);
      setText(el.modeChip, mChip);
      setText(el.modeSub, mSub);

      // ---- MGU-K power flow + taper ceiling (bar/number use the smoothed net
      // so they read the true dominant flow rather than the per-tick spikes)
      const dispPw = smoothPw;
      const capW = en.overrideActive ? deployCapOverrideW(vKmh) : deployCapNormalW(vKmh);
      const frac = Math.min(1, Math.abs(dispPw) / PU.K_POWER);
      if (dispPw >= 0) { setStyle(el.pwDeploy, 'width', frac * 50); setStyle(el.pwHarvest, 'width', 0); }
      else { setStyle(el.pwDeploy, 'width', 0); setStyle(el.pwHarvest, 'width', frac * 50); }
      // ceiling marker: cap as a fraction of 350 kW, placed on the deploy half
      const capFrac = Math.min(1, capW / PU.K_POWER);
      setStyle(el.pwCap, 'left', 50 + capFrac * 50);
      setText(el.pwKw, `${dispPw < 0 ? '−' : ''}${Math.round(Math.abs(dispPw) / 1e3)} kW`);
      setClass(el.pwKw, 'tel-pw-kw', dispPw < -EXIT_W ? 'is-harvest' : 'is-deploy');
      setText(el.capTxt, `350 kW rated · cap ${Math.round(capW / 1e3)} kW @ ${Math.round(vKmh)} km/h`);

      // ---- rolling trace sample (throttled to ~20 Hz; the canvas is redrawn
      // only when a fresh point lands, so it costs ~20 fills/s not one per
      // render frame — cheap even under software rasterization)
      setText(el.traceV, `${Math.round(vKmh)} km/h`);
      const nowT = performance.now();
      if (nowT - lastSampleT >= SAMPLE_MS) {
        lastSampleT = nowT;
        traceT.push(nowT);
        traceV.push(p.v);
        traceP.push(pw);
        const cutoff = nowT - TRACE_MS;
        while (traceT.length > 1 && traceT[0] < cutoff) { traceT.shift(); traceV.shift(); traceP.shift(); }
        if (detail && visible) drawTrace();
      }

      // ---- battery + budget
      const socFrac = Math.max(0, Math.min(1, en.soc / PU.ES_WINDOW));
      setStyle(el.socFill, 'width', socFrac * 100);
      setClass(el.socFill, 'tel-soc-fill', socFrac < 0.2 ? 'is-low' : 'is-ok');
      setText(el.soc, `${(en.soc / 1e6).toFixed(2)} MJ · ${Math.round(socFrac * 100)}%`);
      const budget = PU.HARVEST_CAP_RACE;
      setText(el.dep, (en.deployedThisLap / 1e6).toFixed(2));
      setText(el.har, (en.harvestedThisLap / 1e6).toFixed(2));
      setStyle(el.budgetFill, 'width', Math.min(100, (en.deployedThisLap / budget) * 100));
      setStyle(el.budgetHarv, 'width', Math.min(100, (en.harvestedThisLap / budget) * 100));

      // ---- Manual Override explainer (teach the 1.0s rule)
      const gap = state.gapSeconds; // player − rival: >0 means a car is ahead
      const dist = Math.round(wrapS(track, track.detectionLineS - p.s));
      let oMod: string, oState: string, oExplain: string;
      if (en.overrideActive) {
        oMod = 'is-active'; oState = 'ACTIVE';
        oExplain = 'Striking now — higher power ceiling, full 350 kW up to 337 km/h.';
      } else if (en.overrideArmed) {
        oMod = 'is-armed'; oState = 'ARMED';
        oExplain = 'Ready this lap — hold SPACE on a straight to unleash it.';
      } else if (gap > 0 && gap < OVERRIDE.DETECTION_GAP) {
        oMod = 'is-eligible'; oState = 'IN RANGE';
        oExplain = `Within ${OVERRIDE.DETECTION_GAP.toFixed(1)}s of the car ahead — cross the detection line here to arm.`;
      } else if (gap > 0) {
        oMod = 'is-locked'; oState = 'LOCKED';
        oExplain = `Close the gap under ${OVERRIDE.DETECTION_GAP.toFixed(1)}s before the detection line to arm.`;
      } else {
        oMod = 'is-locked'; oState = 'LEADING';
        oExplain = 'You lead — Override arms only when hunting a car ahead.';
      }
      setClass(el.ovr, 'tel-block tel-ovr', oMod);
      setText(el.ovrState, oState);
      setText(el.ovrExplain, oExplain);
      // gap bar: 0..2.0s scale, threshold marker at 1.0s (50%)
      const gapShown = gap > 0 ? gap : 0;
      setStyle(el.gapFill, 'width', Math.min(100, (gapShown / (OVERRIDE.DETECTION_GAP * 2)) * 100));
      setClass(el.gapFill, 'tel-gap-fill', gap > 0 && gap < OVERRIDE.DETECTION_GAP ? 'is-in' : 'is-out');
      const gapStr = gap > 0 ? `${gap.toFixed(2)}s` : 'leading';
      setText(el.ovrDetail, `gap ${gapStr} / ${OVERRIDE.DETECTION_GAP.toFixed(2)}s · detection ${dist} m`);

      // ---- tow / throttle / brake
      if (p.inTow) { setClass(el.tow, 'tel-tow', 'is-on'); setText(el.tow, 'IN THE TOW · −28% DRAG'); }
      else { setClass(el.tow, 'tel-tow', 'is-off'); setText(el.tow, 'CLEAN AIR'); }
      setStyle(el.thrFill, 'width', Math.max(0, Math.min(1, p.throttle)) * 100);
      setStyle(el.brkFill, 'width', Math.max(0, Math.min(1, p.brake)) * 100);

      // ---- per-sector splits (live for the current sector)
      const cs = p.currentSectors;
      const s1 = cs[0], s2 = cs[1], s3 = cs[2];
      const inSector = p.s < track.sector2S ? 1 : p.s < track.sector3S ? 2 : 3;
      const lt = p.currentLapTime;
      const disp: (string)[] = [
        s1 != null ? fmtSec(s1) : (inSector === 1 ? fmtSec(lt) : '--.--'),
        s2 != null ? fmtSec(s2) : (inSector === 2 && s1 != null ? fmtSec(lt - s1) : '--.--'),
        s3 != null ? fmtSec(s3) : (inSector === 3 && s1 != null && s2 != null ? fmtSec(lt - s1 - s2) : '--.--'),
      ];
      for (let i = 0; i < 3; i++) {
        setText(el.secT[i], disp[i]);
        setClass(el.sec[i], 'tel-sec', inSector === i + 1 ? 'is-live' : '');
      }
    },
  };
}
