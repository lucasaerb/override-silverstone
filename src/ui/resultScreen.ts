/**
 * Result screen. Shows the outcome (WIN / P2), final gap, a per-lap time table
 * for both cars, a gap-history chart (green when the player leads) and a
 * per-lap energy-deployed comparison. Buttons: Race Again (same map + seed),
 * Change Strategy, Menu.
 *
 * Below the outcome cards it renders a POST-RACE ENGINEER'S DEBRIEF: an
 * evidence-based comparison of the player's energy strategy against the
 * simulation's OPTIMAL deploy map (solved in a Web Worker, cached per track).
 * It teaches — with numbers — how much lap time was left on the table and,
 * per zone, where energy should have been spent, saved, or harvested. The
 * analysis fills in asynchronously; the static outcome cards render instantly.
 */
import type { DeployMap, TrackData } from '../sim/types';
import type { OptimizeResult, ZoneValueAnalysis } from '../sim/optimizer';
import { solveOptimal, analyzeZones } from './solverClient';

export interface LapEnergy {
  deployed: number;
  harvested: number;
}

export interface RaceResult {
  playerWon: boolean;
  /** player-minus-rival finish gap, s (negative = player ahead) */
  finalGap: number;
  laps: number;
  playerLaps: number[];
  rivalLaps: number[];
  /** gapSeconds sampled through the race (player-minus-rival) */
  gapHistory: number[];
  playerEnergy: LapEnergy[];
  rivalEnergy: LapEnergy[];
  /** the player's planned deployment map (for the post-race analysis) */
  playerMap: DeployMap;
  /** the rival's deployment map, if available */
  rivalMap?: DeployMap;
  /** game mode; drives the verdict headline + whether the rival columns show */
  mode?: 'timetrial' | 'optimal' | 'overtake' | 'multiplayer';
  /** solo mode (time trial / optimal) — no rival to compare against */
  solo?: boolean;
  /** mode-specific verdict shown above the gap */
  verdict?: {
    kind: 'challenge-win' | 'challenge-loss' | 'record' | 'laptime';
    title: string;
    note: string;
  };
}

export interface ResultScreenHandle {
  root: HTMLElement;
  show(result: RaceResult): void;
  hide(): void;
  onAgain(cb: () => void): void;
  onStrategy(cb: () => void): void;
  onMenu(cb: () => void): void;
}

// on-brand colours (mirror screens.css so we own no cross-file styling here)
const C_PAPAYA = '#ff8412'; // player / you
const C_TEAL = '#2ab6b0'; // optimal

function fmtLap(t: number | undefined): string {
  if (t == null || !Number.isFinite(t)) return '—';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
}

/** One ranked piece of per-zone evidence. */
interface ZoneImpact {
  zoneId: number;
  name: string;
  kind: 'gain' | 'waste' | 'harvest';
  /** seconds — this zone's share of the measured lap time left on the table */
  impact: number;
  /** did the player harvest/lift here? (sharpens the "deploy here" message) */
  playerLifted: boolean;
}

/**
 * Attribute the measured lap-time deficit (`leftOnTable`) across zones by how
 * the player's map diverges from the optimal map, weighted by each zone's
 * deploy value from the analysis. Every shown number is a slice of the *real*
 * deficit, so the list can never contradict the headline. One lesson per zone:
 *  - gain    : optimal deploys more here than you did (a valuable zone you
 *              under-fed) → "deploy here".
 *  - waste   : you put energy where optimal doesn't — a zone that's slow or
 *              negative to deploy in (optimal saves it / harvests it instead).
 *  - harvest : optimal lifts to bank ~free energy here and you did not.
 * Directional weights only shape the *distribution*; the totals stay honest.
 */
function buildZoneImpacts(
  playerMap: DeployMap,
  optMap: DeployMap,
  analysis: ZoneValueAnalysis,
  leftOnTable: number,
): ZoneImpact[] {
  interface Raw { id: number; name: string; kind: ZoneImpact['kind']; score: number; playerLifted: boolean }
  const raws: Raw[] = [];
  for (const zv of analysis.zones) {
    const id = zv.zoneId;
    const vz = zv.deployValueSec; // may be negative (deploying here is slow)
    const dy = playerMap.zoneDeploy[id] ?? 0;
    const dOpt = optMap.zoneDeploy[id] ?? 0;
    const ly = playerMap.zoneLift[id] ?? 0;
    const lOpt = optMap.zoneLift[id] ?? 0;
    // net energy intent: deploy adds, lift/harvest subtracts. Comparing the
    // NET (not deploy and lift separately) correctly catches "you harvested a
    // zone optimal deploys" — the classic amateur mistake — as a deploy gain.
    const nd = (dOpt - lOpt) - (dy - ly);
    if (Math.abs(nd) < 1e-3) continue;

    let kind: ZoneImpact['kind'];
    let weight: number;
    if (nd > 0) {
      // optimal wants more energy here than you spent (you under-deployed or
      // harvested a zone worth deploying) — weight by how valuable it is
      kind = 'gain';
      weight = Math.max(vz, 0.03);
    } else if (lOpt > ly + 1e-3) {
      // optimal banks energy here (cheaply) and you did not — a harvest tip
      kind = 'harvest';
      weight = 0.5;
    } else {
      // you fed energy into a zone optimal leaves alone — worst when the zone
      // is genuinely slow to deploy in (negative value)
      kind = 'waste';
      weight = Math.max(-vz, 0.05);
    }
    raws.push({ id, name: zv.name, kind, score: Math.abs(nd) * weight, playerLifted: ly > 0.01 });
  }
  const sum = raws.reduce((s, r) => s + r.score, 0) || 1;
  return raws
    .map((r) => ({ zoneId: r.id, name: r.name, kind: r.kind, impact: (leftOnTable * r.score) / sum, playerLifted: r.playerLifted }))
    .filter((it) => it.impact >= 0.01)
    .sort((a, b) => b.impact - a.impact);
}

export function createResultScreen(container: HTMLElement, track: TrackData): ResultScreenHandle {
  const root = document.createElement('div');
  root.className = 'screen result-screen';
  root.style.display = 'none';
  root.innerHTML = `
    <div class="result-inner">
      <div class="result-verdict">
        <div class="result-badge">P2</div>
        <div class="result-gap">+0.000</div>
        <div class="result-gap-label">FINISHING GAP</div>
        <div class="result-mode-note"></div>
      </div>
      <div class="result-cols">
        <div class="result-card">
          <div class="result-card-title">LAP TIMES</div>
          <table class="result-table"><thead><tr><th>LAP</th><th>YOU</th><th>RIVAL</th></tr></thead><tbody></tbody></table>
        </div>
        <div class="result-card">
          <div class="result-card-title">GAP HISTORY</div>
          <canvas class="result-gapchart" width="360" height="150"></canvas>
          <div class="result-legend"><span class="lg-you">you ahead</span><span class="lg-riv">rival ahead</span></div>
        </div>
        <div class="result-card">
          <div class="result-card-title">ENERGY DEPLOYED / LAP</div>
          <canvas class="result-energy" width="360" height="150"></canvas>
          <div class="result-legend"><span class="lg-you">you</span><span class="lg-riv">rival</span></div>
        </div>
      </div>

      <div class="analysis-panel">
        <div class="analysis-head">
          <div class="analysis-title">POST-RACE ENGINEER'S DEBRIEF</div>
          <div class="analysis-status">analysing your energy strategy…</div>
        </div>
        <div class="analysis-body">
          <div class="analysis-cols">
            <div class="an-card an-vs">
              <div class="result-card-title">YOUR PACE vs OPTIMAL</div>
              <div class="an-headline">
                <span class="an-big">+0.0s</span>
                <span class="an-headline-sub">per lap left on the table</span>
              </div>
              <div class="an-stats">
                <div><span class="an-l">YOUR BEST LAP</span><span class="an-v an-best">—</span></div>
                <div><span class="an-l">OPTIMAL LAP <em>sustainable</em></span><span class="an-v an-opt">—</span></div>
                <div><span class="an-l">YOUR RACE AVG</span><span class="an-v an-avg">—</span></div>
                <div><span class="an-l">OPTIMAL <em>flying</em></span><span class="an-v an-fly">—</span></div>
              </div>
              <div class="an-encourage"></div>
            </div>
            <div class="an-card an-zones">
              <div class="result-card-title">WHERE YOU GAINED / LOST</div>
              <ul class="an-zone-list"></ul>
            </div>
          </div>
          <div class="an-card an-strip">
            <div class="result-card-title">DEPLOY MAP · YOU vs OPTIMAL — bars = deploy, shading = where energy pays</div>
            <canvas class="an-strip-canvas" width="1040" height="112"></canvas>
            <div class="an-strip-legend">
              <span class="an-lg an-lg-you">your deploy</span>
              <span class="an-lg an-lg-opt">optimal deploy</span>
              <span class="an-lg an-lg-val">deploy value</span>
              <span class="an-lg an-lg-lift">optimal harvest</span>
            </div>
          </div>
        </div>
      </div>

      <div class="result-actions">
        <button class="btn btn-primary result-again">RACE AGAIN</button>
        <button class="btn result-strategy">CHANGE STRATEGY</button>
        <button class="btn result-menu">MENU</button>
      </div>
    </div>`;
  container.appendChild(root);

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`result: missing ${sel}`);
    return el;
  };
  const badge = q('.result-badge');
  const gapEl = q('.result-gap');
  const tbody = q('tbody');
  const gapChart = q<HTMLCanvasElement>('.result-gapchart');
  const energyChart = q<HTMLCanvasElement>('.result-energy');

  // analysis nodes
  const anPanel = q('.analysis-panel');
  const anStatus = q('.analysis-status');
  const anBig = q('.an-big');
  const anEncourage = q('.an-encourage');
  const anBest = q('.an-best');
  const anAvg = q('.an-avg');
  const anOpt = q('.an-opt');
  const anFly = q('.an-fly');
  const anZoneList = q('.an-zone-list');
  const stripCanvas = q<HTMLCanvasElement>('.an-strip-canvas');

  const bind = (sel: string, cb: () => void): void => q(sel).addEventListener('click', cb);
  let againCb: () => void, stratCb: () => void, menuCb: () => void;
  bind('.result-again', () => againCb?.());
  bind('.result-strategy', () => stratCb?.());
  bind('.result-menu', () => menuCb?.());

  // generation token: bail out of a stale async render if the screen moved on
  let showGen = 0;

  const drawGapChart = (hist: number[]): void => {
    const g = gapChart.getContext('2d');
    if (!g) return;
    const w = gapChart.width, h = gapChart.height;
    g.clearRect(0, 0, w, h);
    let peak = 0.5;
    for (const v of hist) peak = Math.max(peak, Math.abs(v));
    const mid = h / 2;
    const yOf = (v: number): number => mid + (v / peak) * (mid - 8); // v>0 (player behind) → below
    // zero line
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
    if (hist.length > 1) {
      // shade region between the curve and the mid line (green above = you ahead)
      g.beginPath();
      g.moveTo(0, mid);
      hist.forEach((v, i) => g.lineTo((i / (hist.length - 1)) * w, yOf(v)));
      g.lineTo(w, mid);
      g.closePath();
      g.fillStyle = 'rgba(255,132,18,0.14)';
      g.fill();
      g.beginPath();
      hist.forEach((v, i) => {
        const x = (i / (hist.length - 1)) * w;
        const y = yOf(v);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.strokeStyle = '#ff8412';
      g.lineWidth = 2;
      g.stroke();
    }
    g.fillStyle = 'rgba(200,208,218,0.6)';
    g.font = '10px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText(`±${peak.toFixed(1)}s`, 4, 12);
  };

  const drawEnergyChart = (you: LapEnergy[], riv: LapEnergy[]): void => {
    const g = energyChart.getContext('2d');
    if (!g) return;
    const w = energyChart.width, h = energyChart.height, pad = 18;
    g.clearRect(0, 0, w, h);
    const n = Math.max(you.length, riv.length);
    if (n === 0) return;
    let peak = 4;
    for (const e of [...you, ...riv]) peak = Math.max(peak, e.deployed);
    const groupW = (w - 2 * pad) / n;
    const barW = groupW * 0.32;
    const base = h - 16;
    for (let i = 0; i < n; i++) {
      const gx = pad + i * groupW + groupW / 2;
      const yv = you[i]?.deployed ?? 0;
      const rv = riv[i]?.deployed ?? 0;
      const yh = (yv / peak) * (base - 10);
      const rh = (rv / peak) * (base - 10);
      g.fillStyle = '#ff8412';
      g.fillRect(gx - barW - 2, base - yh, barW, yh);
      g.fillStyle = '#2ab6b0';
      g.fillRect(gx + 2, base - rh, barW, rh);
      g.fillStyle = 'rgba(200,208,218,0.6)';
      g.font = '10px ui-sans-serif, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(`L${i + 1}`, gx, base + 12);
    }
  };

  // horizontal per-zone strip: value heat-map + your deploy bars vs the optimal
  // target outline, with a harvest lane below the baseline. Cheap, fixed-size
  // canvas scaled by CSS.
  const drawStrip = (analysis: ZoneValueAnalysis, playerMap: DeployMap, optMap: DeployMap): void => {
    const g = stripCanvas.getContext('2d');
    if (!g) return;
    const w = stripCanvas.width, h = stripCanvas.height;
    g.clearRect(0, 0, w, h);
    const baseline = h - 26;
    const usable = baseline - 8;
    const L = track.length;

    for (const zv of analysis.zones) {
      const zone = track.zones[zv.zoneId];
      if (!zone) continue;
      const x0 = (zone.sStart / L) * w;
      const x1 = (zone.sEnd / L) * w;
      const bandW = Math.max(1, x1 - x0 - 1);
      const cx = (x0 + x1) / 2;
      const barW = Math.max(2, Math.min(22, (x1 - x0) * 0.46));

      // value heat background — where energy is worth spending
      g.fillStyle = `rgba(61,220,132,${0.05 + 0.24 * zv.valueNorm})`;
      g.fillRect(x0, 4, bandW, baseline - 4);

      const dy = playerMap.zoneDeploy[zv.zoneId] ?? 0;
      const dOpt = optMap.zoneDeploy[zv.zoneId] ?? 0;
      const ly = playerMap.zoneLift[zv.zoneId] ?? 0;
      const lOpt = optMap.zoneLift[zv.zoneId] ?? 0;

      // your deploy — solid papaya bar
      if (dy > 0) {
        const bh = dy * usable;
        g.fillStyle = C_PAPAYA;
        g.fillRect(cx - barW / 2, baseline - bh, barW, bh);
      }
      // optimal deploy — teal target outline
      if (dOpt > 0) {
        const bh = dOpt * usable;
        g.strokeStyle = C_TEAL;
        g.lineWidth = 2;
        g.strokeRect(cx - barW / 2, baseline - bh + 1, barW, bh - 1);
      }
      // harvest lanes below baseline: optimal harvest zones (blue, game's lift
      // colour) over the player's own harvest (papaya = you)
      if (lOpt > 0) {
        g.fillStyle = `rgba(55,166,255,${0.45 + 0.45 * lOpt})`;
        g.fillRect(x0, baseline + 4, bandW, 5);
      }
      if (ly > 0) {
        g.fillStyle = `rgba(255,132,18,${0.5 + 0.4 * ly})`;
        g.fillRect(x0, baseline + 12, bandW, 5);
      }
    }

    // baseline
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, baseline + 0.5); g.lineTo(w, baseline + 0.5); g.stroke();
  };

  const encourageFor = (leftOnTable: number): string => {
    if (leftOnTable < 0.12) return 'Dialled in — your deployment was essentially optimal. Nothing left out there.';
    if (leftOnTable < 0.6) return 'Sharp strategy. Tidy up the zones below and the rest is yours.';
    if (leftOnTable < 1.6) return 'Good instincts — but energy went unspent where it pays most. The green zones are free lap time.';
    return 'Big gains available: you left the battery on the table. Deploy on the fast zones, bank it in the slow ones.';
  };

  const renderAnalysis = (result: RaceResult, opt: OptimizeResult, analysis: ZoneValueAnalysis): void => {
    // ---- pace vs optimal
    const finite = result.playerLaps.filter((t) => Number.isFinite(t));
    const best = finite.length ? Math.min(...finite) : NaN;
    // race average excluding the standing-start lap 1 (fair vs a flying optimum)
    const racing = result.playerLaps.length > 1
      ? result.playerLaps.slice(1).filter((t) => Number.isFinite(t))
      : finite;
    const avg = racing.length ? racing.reduce((a, b) => a + b, 0) / racing.length : NaN;
    const optSustain = opt.lapTime;
    const optFly = opt.flyingLapTime;

    const leftOnTable = Number.isFinite(avg) ? Math.max(0, avg - optSustain) : 0;
    anBig.textContent = `+${leftOnTable.toFixed(1)}s`;
    anBig.className = `an-big ${leftOnTable < 0.12 ? 'is-onpace' : leftOnTable < 1.6 ? 'is-close' : 'is-far'}`;
    anEncourage.textContent = encourageFor(leftOnTable);
    anBest.textContent = fmtLap(best);
    anAvg.textContent = fmtLap(avg);
    anOpt.textContent = fmtLap(optSustain);
    anFly.textContent = fmtLap(optFly);

    // ---- per-zone evidence (each row a slice of the measured deficit above)
    const impacts = buildZoneImpacts(result.playerMap, opt.map, analysis, leftOnTable).slice(0, 5);
    if (leftOnTable < 0.1 || impacts.length === 0) {
      anZoneList.innerHTML = '<li class="an-zone-empty">Nothing left out there — your zone-by-zone deployment matched the optimum. Textbook energy management.</li>';
    } else {
      anZoneList.innerHTML = impacts.map((it) => {
        const secs = it.impact.toFixed(it.impact >= 1 ? 1 : 2);
        let msg: string, val: string;
        if (it.kind === 'gain') { msg = it.playerLifted ? 'deploy here — you harvested it' : 'deploy here'; val = `+${secs}s`; }
        else if (it.kind === 'harvest') { msg = 'lift here to bank energy'; val = `+${secs}s`; }
        else { msg = 'wasted — optimal saves it'; val = `−${secs}s`; }
        return `<li class="an-zone-item is-${it.kind}">
          <span class="an-zone-dot"></span>
          <span class="an-zone-name">${it.name}</span>
          <span class="an-zone-msg">${msg}</span>
          <span class="an-zone-impact">${val}</span>
        </li>`;
      }).join('');
    }

    // ---- strip viz
    drawStrip(analysis, result.playerMap, opt.map);
  };

  return {
    root,
    show(result: RaceResult): void {
      root.style.display = 'flex';
      root.classList.toggle('is-solo', !!result.solo);
      const gen = ++showGen;
      const ahead = result.finalGap < 0;
      const v = result.verdict;
      const winish = v ? v.kind === 'challenge-win' || v.kind === 'record' : result.playerWon;
      const lossish = v ? v.kind === 'challenge-loss' : !result.playerWon;
      badge.textContent = v ? v.title : result.playerWon ? 'WIN' : 'P2';
      badge.className = `result-badge ${winish ? 'is-win' : lossish ? 'is-loss' : 'is-loss'}`;
      const gapLabel = root.querySelector('.result-gap-label') as HTMLElement | null;
      const noteEl = root.querySelector('.result-mode-note') as HTMLElement | null;
      if (result.solo) {
        const best = Math.min(...(result.playerLaps.length ? result.playerLaps : [NaN]));
        gapEl.textContent = fmtLap(best);
        gapEl.className = 'result-gap is-ahead';
        if (gapLabel) gapLabel.textContent = 'FASTEST LAP';
      } else {
        gapEl.textContent = `${ahead ? '−' : '+'}${Math.abs(result.finalGap).toFixed(3)}`;
        gapEl.className = `result-gap ${ahead ? 'is-ahead' : 'is-behind'}`;
        if (gapLabel) gapLabel.textContent = 'FINISHING GAP';
      }
      if (noteEl) noteEl.textContent = v?.note ?? '';

      const rows: string[] = [];
      const laps = Math.max(result.playerLaps.length, result.rivalLaps.length);
      let pBest = Infinity, rBest = Infinity;
      for (const t of result.playerLaps) pBest = Math.min(pBest, t);
      for (const t of result.rivalLaps) rBest = Math.min(rBest, t);
      for (let i = 0; i < laps; i++) {
        const p = result.playerLaps[i];
        const r = result.rivalLaps[i];
        const pc = p === pBest ? ' class="best"' : '';
        const rc = r === rBest ? ' class="best"' : '';
        rows.push(`<tr><td>${i + 1}</td><td${pc}>${fmtLap(p)}</td><td${rc}>${fmtLap(r)}</td></tr>`);
      }
      tbody.innerHTML = rows.join('');
      drawGapChart(result.gapHistory);
      drawEnergyChart(result.playerEnergy, result.rivalEnergy);

      // ---- async post-race analysis (usually cached → near-instant)
      anPanel.classList.remove('is-ready', 'is-failed');
      anStatus.textContent = 'analysing your energy strategy…';
      Promise.all([solveOptimal(track), analyzeZones(track)])
        .then(([opt, analysis]) => {
          if (gen !== showGen || root.style.display === 'none') return; // moved on
          renderAnalysis(result, opt, analysis);
          anPanel.classList.add('is-ready');
        })
        .catch(() => {
          if (gen !== showGen) return;
          anStatus.textContent = 'analysis unavailable';
          anPanel.classList.add('is-failed');
        });
    },
    hide(): void { root.style.display = 'none'; showGen++; },
    onAgain(cb): void { againCb = cb; },
    onStrategy(cb): void { stratCb = cb; },
    onMenu(cb): void { menuCb = cb; },
  };
}
