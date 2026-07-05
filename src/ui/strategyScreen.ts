/**
 * Strategy screen — the core pre-race screen. A large interactive Silverstone
 * map (TrackMap) the player paints a deployment map onto: left-click a zone to
 * cycle its deploy %, right-click to cycle its lift/harvest level. A side panel
 * runs a real headless lap projection on every (debounced) edit and shows the
 * projected lap time, energy deployed vs the 8.0 MJ budget, top speed, the
 * SPEED-around-the-lap chart and the SoC trace, plus a selected-zone inspector
 * (zoomed speed chart + deploy/lift chips + a "vs no-deploy" delta), presets,
 * rival difficulty, race length and a shareable seed.
 */
import type { DeployMap, TrackData } from '../sim/types';
import { PU } from '../sim/constants';
import { AI_MAPS } from '../sim/aiDriver';
import { projectLap, type LapProjection } from '../sim/projection';
import { TrackMap, cycleLevel, DEPLOY_STEPS, type EditKind } from './trackMap';
import { drawSpeedChart, speedAtS } from './speedChart';
import { solveOptimal, analyzeZones, cloneMap } from './solverClient';
import type { OptimizeResult, ZoneValueAnalysis } from '../sim/optimizer';

export type RivalSkill = 'balanced' | 'aggressive' | 'defensive';

export interface RaceSetup {
  playerMap: DeployMap;
  rivalSkill: RivalSkill;
  laps: number;
  seed: number;
}

export interface StrategyScreenHandle {
  root: HTMLElement;
  show(): void;
  hide(): void;
  render(): void;
  getSetup(): RaceSetup;
  getMap(): DeployMap;
  setMap(map: DeployMap): void;
  onRace(cb: (setup: RaceSetup) => void): void;
}

function emptyMap(track: TrackData): DeployMap {
  return { zoneDeploy: track.zones.map(() => 0), zoneLift: track.zones.map(() => 0) };
}

function clone(map: DeployMap): DeployMap {
  return { zoneDeploy: [...map.zoneDeploy], zoneLift: [...map.zoneLift] };
}

/** The race-tested "Hunt" strategy, built by zone name so it survives re-indexing. */
function huntMap(track: TrackData): DeployMap {
  const deploy: Record<string, number> = {
    'Pit Straight': 1, 'Abbey–Farm': 0, 'Village Brake': 0.5, 'The Loop': 0.75,
    'Aintree Exit': 1, 'Wellington Straight': 1, Brooklands: 0, Luffield: 0,
    Woodcote: 1, 'National Straight': 1, Copse: 1, Maggotts: 0, Becketts: 0,
    'Chapel Exit': 1, 'Hangar Straight': 1, Stowe: 0.25, 'Vale Brake': 0.25,
    Club: 1, 'Club Exit': 1,
  };
  const lift: Record<string, number> = {
    'Village Brake': 0.25, 'The Loop': 0.5, Stowe: 0.5, 'Vale Brake': 0.5, Club: 0.75,
  };
  return {
    zoneDeploy: track.zones.map((z) => deploy[z.name] ?? 0),
    zoneLift: track.zones.map((z) => lift[z.name] ?? 0),
  };
}

function fmtLap(t: number): string {
  if (!Number.isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
}

function fmtSigned(v: number, digits: number, unit: string): string {
  if (!Number.isFinite(v)) return `– ${unit}`;
  const s = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${s}${Math.abs(v).toFixed(digits)} ${unit}`;
}

/** Δ vs the same map with the selected zone zeroed. */
interface ZoneDelta {
  lapGain: number;   // s saved by the current setting vs zeroing this zone (>0 = faster)
  exitGain: number;  // km/h faster at the zone exit vs zeroing this zone
  used: boolean;     // does this zone use any energy right now?
}

export function createStrategyScreen(
  container: HTMLElement,
  track: TrackData,
  initial: RaceSetup,
): StrategyScreenHandle {
  let map = clone(initial.playerMap);
  let rivalSkill: RivalSkill = initial.rivalSkill;
  let laps = initial.laps;
  let seed = initial.seed;
  let raceCb: ((s: RaceSetup) => void) | null = null;

  let lastProj: LapProjection | null = null;
  let selectedZone: number | null = null;
  let deltaResult: ZoneDelta | null = null;

  // ---- evidence-coaching state (heat-map + optimal solve + ghost trace)
  let heatmapOn = false;
  let analyzing = false;
  let zoneAnalysis: ZoneValueAnalysis | null = null;
  let solving = false;
  let optimal: OptimizeResult | null = null;
  let optimalGhost: Float32Array | null = null;

  const budgetMJ = (PU.HARVEST_CAP_RACE / 1e6).toFixed(1);

  const root = document.createElement('div');
  root.className = 'screen strategy-screen';
  root.style.display = 'none';
  root.innerHTML = `
    <div class="strat-head">
      <div class="strat-title">RACE STRATEGY <span class="strat-sub">— SILVERSTONE · 2026 ENERGY DUEL</span></div>
      <div class="strat-hint">Left-click a zone: deploy&nbsp;% &nbsp;·&nbsp; Right-click: harvest / lift &nbsp;·&nbsp; click to inspect its speed trace &nbsp;·&nbsp; spend where it passes, bank where you're grip-limited</div>
    </div>
    <div class="strat-body">
      <div class="strat-map"></div>
      <aside class="strat-panel">
        <div class="strat-card strat-proj">
          <div class="strat-card-title">PROJECTED FLYING LAP</div>
          <div class="strat-laptime">--:--.---</div>
          <div class="strat-proj-grid">
            <div><span class="pl">DEPLOYED</span><span class="strat-deploy pv">0.0 MJ</span></div>
            <div><span class="pl">HARVEST</span><span class="strat-harvest pv">0.0 MJ</span></div>
            <div><span class="pl">TOP SPD</span><span class="strat-top pv">0 km/h</span></div>
            <div><span class="pl">BUDGET</span><span class="strat-budget pv">8.0 MJ</span></div>
          </div>
          <div class="strat-spark-label">SPEED AROUND THE LAP, km/h</div>
          <canvas class="strat-speed" width="304" height="120"></canvas>
          <div class="strat-speed-legend" hidden>
            <span class="ssl-you">you</span>
            <span class="ssl-opt">optimal</span>
          </div>
          <div class="strat-spark-label">STATE OF CHARGE &amp; DEPLOY AROUND THE LAP</div>
          <canvas class="strat-spark" width="304" height="76"></canvas>
        </div>

        <div class="strat-card strat-coach">
          <div class="strat-card-title">COACH — LEARN FROM THE EVIDENCE</div>
          <div class="coach-actions">
            <button class="btn coach-heat">SHOW DEPLOY VALUE</button>
            <button class="btn coach-solve">SOLVE OPTIMAL</button>
          </div>
          <div class="coach-heat-legend" hidden>
            <span class="chl-item chl-hi">high value → deploy</span>
            <span class="chl-item chl-lo">low → don't</span>
            <span class="chl-item chl-neg">wastes time</span>
          </div>
          <div class="coach-solving" hidden>
            <div class="coach-solving-label">Solving the optimal strategy…</div>
            <div class="coach-progress"><div class="coach-progress-bar"></div></div>
          </div>
          <div class="coach-result" hidden>
            <div class="coach-opt-grid">
              <div><span class="pl">OPTIMAL LAP</span><span class="coach-opt-flying pv">--:--.---</span></div>
              <div><span class="pl">RACE PACE</span><span class="coach-opt-race pv">--:--.---</span></div>
            </div>
            <div class="coach-gap">
              <span class="coach-gap-you">your lap <b class="coach-you-flying">--:--.---</b></span>
              <span class="coach-gap-headline">leaving <b class="coach-gap-val">–</b> on the table</span>
            </div>
            <div class="coach-gains">
              <div class="coach-gains-title">BIGGEST GAINS</div>
              <ul class="coach-gains-list"></ul>
            </div>
            <button class="btn btn-primary coach-apply">USE OPTIMAL MAP</button>
          </div>
        </div>

        <div class="strat-card strat-zone is-empty">
          <div class="strat-card-title">SELECTED ZONE</div>
          <div class="strat-zone-empty">Click any zone on the map to inspect its speed trace and tune its deploy / lift.</div>
          <div class="strat-zone-body">
            <div class="strat-zone-head">
              <span class="strat-zone-name">—</span>
              <span class="strat-zone-badges"></span>
            </div>
            <div class="strat-zone-meta">
              <div><span class="pl">LENGTH</span><span class="strat-zone-len pv">—</span></div>
              <div><span class="pl">KIND</span><span class="strat-zone-kind pv">—</span></div>
            </div>
            <div class="strat-zone-corners"></div>
            <div class="strat-zone-value" hidden></div>
            <div class="strat-levels">
              <div class="strat-level-row">
                <span class="strat-level-lbl is-deploy">DEPLOY</span>
                <div class="strat-chips deploy-chips"></div>
              </div>
              <div class="strat-level-row">
                <span class="strat-level-lbl is-lift">LIFT</span>
                <div class="strat-chips lift-chips"></div>
              </div>
            </div>
            <div class="strat-spark-label">SPEED THROUGH THIS ZONE, km/h</div>
            <canvas class="strat-zone-chart" width="304" height="112"></canvas>
            <div class="strat-zone-delta">
              <div class="strat-zone-delta-title">vs no deploy / lift here</div>
              <div class="strat-zone-delta-grid">
                <div><span class="pl">Δ LAP</span><span class="strat-dlap pv">–</span></div>
                <div><span class="pl">Δ EXIT</span><span class="strat-dexit pv">–</span></div>
              </div>
            </div>
          </div>
        </div>

        <div class="strat-card">
          <div class="strat-card-title">PRESETS</div>
          <div class="strat-presets">
            <button class="btn preset" data-preset="hunt">Hunt</button>
            <button class="btn preset" data-preset="balanced">Balanced</button>
            <button class="btn preset" data-preset="clear">Clear</button>
          </div>
        </div>
        <div class="strat-card">
          <div class="strat-card-title">RIVAL</div>
          <div class="strat-seg" data-group="skill">
            <button class="seg" data-skill="balanced">Balanced</button>
            <button class="seg" data-skill="aggressive">Aggressive</button>
            <button class="seg" data-skill="defensive">Defensive</button>
          </div>
          <div class="strat-card-title" style="margin-top:12px">LAPS</div>
          <div class="strat-seg" data-group="laps">
            <button class="seg" data-laps="3">3</button>
            <button class="seg" data-laps="5">5</button>
            <button class="seg" data-laps="7">7</button>
          </div>
          <div class="strat-seed">
            <span class="strat-card-title">SEED</span>
            <input class="strat-seed-input" type="number" min="0" step="1" />
            <button class="btn seed-rand" title="Random seed">🎲</button>
          </div>
        </div>
        <div class="strat-card strat-legend">
          <div class="strat-card-title">HOW IT WORKS</div>
          <div class="leg-row"><span class="leg-dot is-deploy"></span><b>Deploy&nbsp;%</b> — MGU-K power you spend here (350 kW, tapers past 290 km/h).</div>
          <div class="leg-row"><span class="leg-dot is-lift"></span><b>Lift</b> — back off early to harvest &amp; recover charge into the battery.</div>
          <div class="leg-row"><span class="leg-dot is-budget"></span><b>${budgetMJ} MJ / lap</b> harvest budget — superclip means 0% at full throttle still recovers.</div>
          <div class="leg-row"><span class="leg-dot is-space"></span><b>SPACE</b> in the race = live push-to-deploy Manual Override.</div>
        </div>
        <button class="btn btn-primary strat-race">RACE →</button>
      </aside>
    </div>`;
  container.appendChild(root);

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`strategy: missing ${sel}`);
    return el;
  };

  const mapHost = q('.strat-map');
  const trackMap = new TrackMap(track, { interactive: true, showLabels: true, zoneWidth: 7 });
  mapHost.appendChild(trackMap.canvas);
  trackMap.setMap(map);

  const applyEdit = (zoneId: number, kind: EditKind): void => {
    if (kind === 'deploy') {
      map.zoneDeploy[zoneId] = cycleLevel(map.zoneDeploy[zoneId]);
      if (map.zoneDeploy[zoneId] > 0) map.zoneLift[zoneId] = 0; // deploy and lift are exclusive
    } else {
      map.zoneLift[zoneId] = cycleLevel(map.zoneLift[zoneId]);
      if (map.zoneLift[zoneId] > 0) map.zoneDeploy[zoneId] = 0;
    }
    trackMap.setMap(map);
    scheduleProjection();
  };
  trackMap.onEdit(applyEdit);
  trackMap.onSelect((zoneId) => {
    selectedZone = zoneId;
    trackMap.setSelected(zoneId);
    deltaResult = null;
    refreshZone();
    scheduleDelta();
  });

  const el = {
    lap: q('.strat-laptime'),
    deploy: q('.strat-deploy'),
    harvest: q('.strat-harvest'),
    top: q('.strat-top'),
    budget: q('.strat-budget'),
    speed: q<HTMLCanvasElement>('.strat-speed'),
    spark: q<HTMLCanvasElement>('.strat-spark'),
    seed: q<HTMLInputElement>('.strat-seed-input'),
    // zone card
    zoneCard: q('.strat-zone'),
    zoneName: q('.strat-zone-name'),
    zoneBadges: q('.strat-zone-badges'),
    zoneLen: q('.strat-zone-len'),
    zoneKind: q('.strat-zone-kind'),
    zoneCorners: q('.strat-zone-corners'),
    zoneChart: q<HTMLCanvasElement>('.strat-zone-chart'),
    deployChips: q('.deploy-chips'),
    liftChips: q('.lift-chips'),
    dLap: q('.strat-dlap'),
    dExit: q('.strat-dexit'),
    zoneValue: q('.strat-zone-value'),
    // coach
    speedLegend: q('.strat-speed-legend'),
    coachHeat: q<HTMLButtonElement>('.coach-heat'),
    coachSolve: q<HTMLButtonElement>('.coach-solve'),
    coachHeatLegend: q('.coach-heat-legend'),
    coachSolving: q('.coach-solving'),
    coachProgressBar: q('.coach-progress-bar'),
    coachResult: q('.coach-result'),
    coachOptFlying: q('.coach-opt-flying'),
    coachOptRace: q('.coach-opt-race'),
    coachYouFlying: q('.coach-you-flying'),
    coachGapVal: q('.coach-gap-val'),
    coachGainsList: q('.coach-gains-list'),
    coachApply: q<HTMLButtonElement>('.coach-apply'),
  };
  el.budget.textContent = `${budgetMJ} MJ`;
  el.seed.value = String(seed);

  // ---- deploy / lift level chips inside the zone card (built once)
  const buildChips = (host: HTMLElement, kind: EditKind): void => {
    for (const level of DEPLOY_STEPS) {
      const chip = document.createElement('button');
      chip.className = `strat-chip is-${kind}`;
      chip.dataset.level = String(level);
      chip.textContent = level === 0 ? 'Off' : `${Math.round(level * 100)}`;
      chip.addEventListener('click', () => {
        if (selectedZone == null) return;
        if (kind === 'deploy') {
          map.zoneDeploy[selectedZone] = level;
          if (level > 0) map.zoneLift[selectedZone] = 0;
        } else {
          map.zoneLift[selectedZone] = level;
          if (level > 0) map.zoneDeploy[selectedZone] = 0;
        }
        trackMap.setMap(map);
        refreshZone();
        scheduleProjection();
        scheduleDelta();
      });
      host.appendChild(chip);
    }
  };
  buildChips(el.deployChips, 'deploy');
  buildChips(el.liftChips, 'lift');

  // ---- projection (debounced; the sim is fast but edits can burst)
  let projTimer = 0;
  const runProjection = (): void => {
    const p = projectLap(track, map);
    lastProj = p;
    el.lap.textContent = fmtLap(p.lapTime);
    el.deploy.textContent = `${p.deployedMJ.toFixed(1)} MJ`;
    el.harvest.textContent = `${p.harvestedMJ.toFixed(1)} MJ`;
    el.top.textContent = `${Math.round(p.topSpeedKmh)} km/h`;
    el.deploy.classList.toggle('over', p.deployedMJ > PU.HARVEST_CAP_RACE / 1e6 + 4.05);
    drawSpeed(p);
    drawSpark(p);
    if (selectedZone != null) refreshZone();
    if (optimal) updateCoach(); // live "you vs optimal" as the map is edited
  };
  const scheduleProjection = (): void => {
    window.clearTimeout(projTimer);
    projTimer = window.setTimeout(runProjection, 150);
  };

  // ---- "Δ vs no deploy" for the selected zone (separately debounced: it costs
  // an extra projectLap, so we keep it off the fast edit path)
  let deltaTimer = 0;
  const runDelta = (): void => {
    if (selectedZone == null || !lastProj) return;
    const zone = track.zones[selectedZone];
    const d0 = map.zoneDeploy[selectedZone] ?? 0;
    const l0 = map.zoneLift[selectedZone] ?? 0;
    const used = d0 > 0 || l0 > 0;
    const zeroed = clone(map);
    zeroed.zoneDeploy[selectedZone] = 0;
    zeroed.zoneLift[selectedZone] = 0;
    const base = projectLap(track, zeroed);
    const exitS = Math.max(zone.sStart, zone.sEnd - 1);
    const curExit = speedAtS(lastProj.speedSeries, track, exitS);
    const baseExit = speedAtS(base.speedSeries, track, exitS);
    deltaResult = {
      lapGain: base.lapTime - lastProj.lapTime,
      exitGain: curExit - baseExit,
      used,
    };
    updateDelta();
  };
  const scheduleDelta = (): void => {
    window.clearTimeout(deltaTimer);
    updateDelta(); // show "…" / stale immediately
    deltaTimer = window.setTimeout(runDelta, 260);
  };

  const updateDelta = (): void => {
    if (selectedZone == null) return;
    if (!deltaResult) {
      el.dLap.textContent = '…';
      el.dExit.textContent = '…';
      el.dLap.className = 'strat-dlap pv';
      el.dExit.className = 'strat-dexit pv';
      return;
    }
    if (!deltaResult.used) {
      el.dLap.textContent = 'no energy';
      el.dExit.textContent = 'here';
      el.dLap.className = 'strat-dlap pv';
      el.dExit.className = 'strat-dexit pv';
      return;
    }
    // lapGain > 0 → current setting is faster than empty → good (green)
    el.dLap.textContent = fmtSigned(-deltaResult.lapGain, 2, 's');
    el.dExit.textContent = fmtSigned(deltaResult.exitGain, 0, 'km/h');
    el.dLap.className = `strat-dlap pv ${deltaResult.lapGain > 0.003 ? 'is-good' : deltaResult.lapGain < -0.003 ? 'is-bad' : ''}`;
    el.dExit.className = `strat-dexit pv ${deltaResult.exitGain > 0.5 ? 'is-good' : deltaResult.exitGain < -0.5 ? 'is-bad' : ''}`;
  };

  // ---- selected-zone detail (DOM text + chips + zoom chart)
  const refreshZone = (): void => {
    if (selectedZone == null) {
      el.zoneCard.classList.add('is-empty');
      return;
    }
    const zone = track.zones[selectedZone];
    el.zoneCard.classList.remove('is-empty');
    el.zoneName.textContent = zone.name;
    el.zoneLen.textContent = `${Math.round(zone.sEnd - zone.sStart)} m`;
    el.zoneKind.textContent = zone.kind;

    // badges: accel-zone (350 kW) marker
    el.zoneBadges.innerHTML = zone.accelZone
      ? '<span class="strat-badge is-accel">350 kW ACCEL</span>'
      : '<span class="strat-badge is-nonaccel">250 kW CAP</span>';

    // corners inside the zone, with apex speeds from the current projection
    const inside = track.corners.filter((c) => c.apexS >= zone.sStart && c.apexS < zone.sEnd);
    if (inside.length === 0) {
      el.zoneCorners.innerHTML = '<span class="strat-corner is-none">flat-out — no corner apex</span>';
    } else {
      el.zoneCorners.innerHTML = inside.map((c) => {
        const v = lastProj ? Math.round(speedAtS(lastProj.speedSeries, track, c.apexS)) : '–';
        return `<span class="strat-corner">${c.name} <b>${v}</b><span class="u">km/h</span></span>`;
      }).join('');
    }

    // deploy-value evidence (once the zone analysis is loaded)
    const zv = zoneAnalysis?.zones.find((z) => z.zoneId === selectedZone) ?? null;
    if (zv) {
      const v = zv.deployValueSec;
      el.zoneValue.hidden = false;
      if (v > 0.03) {
        el.zoneValue.className = 'strat-zone-value is-good';
        el.zoneValue.innerHTML = `Deploying here saves <b>${v.toFixed(2)}s</b> — spend energy here`;
      } else if (v < -0.03) {
        el.zoneValue.className = 'strat-zone-value is-bad';
        el.zoneValue.innerHTML = `Deploying here wastes <b>${Math.abs(v).toFixed(2)}s</b> — don't`;
      } else {
        el.zoneValue.className = 'strat-zone-value is-flat';
        el.zoneValue.innerHTML = `Deploying here barely helps — <b>save it</b>`;
      }
    } else {
      el.zoneValue.hidden = true;
    }

    // chip active states
    const d = map.zoneDeploy[selectedZone] ?? 0;
    const l = map.zoneLift[selectedZone] ?? 0;
    el.deployChips.querySelectorAll<HTMLElement>('.strat-chip').forEach((c) => {
      c.classList.toggle('active', Math.abs(Number(c.dataset.level) - d) < 1e-3);
    });
    el.liftChips.querySelectorAll<HTMLElement>('.strat-chip').forEach((c) => {
      c.classList.toggle('active', Math.abs(Number(c.dataset.level) - l) < 1e-3);
    });

    // zoomed speed chart for just this zone (a little context padding either side)
    if (lastProj) {
      const padS = Math.min(120, (zone.sEnd - zone.sStart) * 0.25);
      drawSpeedChart(el.zoneChart, {
        speedSeries: lastProj.speedSeries,
        powerSeries: lastProj.powerSeries,
        deployMap: map,
        track,
        sStart: Math.max(0, zone.sStart - padS),
        sEnd: Math.min(track.length, zone.sEnd + padS),
      });
    }
    updateDelta();
  };

  const drawSpeed = (p: LapProjection): void => {
    drawSpeedChart(el.speed, {
      speedSeries: p.speedSeries,
      ghostSpeedSeries: optimalGhost ?? undefined,
      powerSeries: p.powerSeries,
      deployMap: map,
      track,
    });
    el.speedLegend.hidden = !optimalGhost;
  };

  const drawSpark = (p: LapProjection): void => {
    const c = el.spark;
    const g = c.getContext('2d');
    if (!g) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, c.clientWidth || c.width);
    const h = Math.max(1, c.clientHeight || c.height);
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = p.socSeries.length;
    g.clearRect(0, 0, w, h);
    // zone-tint background bands (deploy green / lift blue) for context
    for (const zone of track.zones) {
      const deploy = map.zoneDeploy[zone.id] ?? 0;
      const lift = map.zoneLift[zone.id] ?? 0;
      if (deploy <= 0 && lift <= 0) continue;
      const x0 = (zone.sStart / track.length) * w;
      const x1 = (zone.sEnd / track.length) * w;
      g.fillStyle = lift > 0
        ? `rgba(55,166,255,${0.08 + 0.14 * lift})`
        : `rgba(46,224,122,${0.06 + 0.16 * deploy})`;
      g.fillRect(x0, 0, x1 - x0, h);
    }
    // SoC area
    g.beginPath();
    g.moveTo(0, h);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - Math.max(0, Math.min(1, p.socSeries[i])) * (h - 4) - 2;
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.closePath();
    g.fillStyle = 'rgba(255,132,18,0.16)';
    g.fill();
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - Math.max(0, Math.min(1, p.socSeries[i])) * (h - 4) - 2;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = '#ff8412';
    g.lineWidth = 1.5;
    g.stroke();
    // sector dividers
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 1;
    for (const s of [track.sector2S, track.sector3S]) {
      const x = (s / track.length) * w;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
  };

  // ---- controls
  const syncSegs = (): void => {
    root.querySelectorAll<HTMLElement>('.strat-seg[data-group="skill"] .seg').forEach((b) => {
      b.classList.toggle('active', b.dataset.skill === rivalSkill);
    });
    root.querySelectorAll<HTMLElement>('.strat-seg[data-group="laps"] .seg').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.laps) === laps);
    });
  };
  root.querySelectorAll<HTMLElement>('.preset').forEach((b) => {
    b.addEventListener('click', () => {
      const which = b.dataset.preset;
      map = which === 'hunt' ? huntMap(track) : which === 'balanced' ? clone(AI_MAPS.balanced) : emptyMap(track);
      trackMap.setMap(map);
      refreshZone();
      scheduleProjection();
      scheduleDelta();
    });
  });
  root.querySelectorAll<HTMLElement>('.strat-seg[data-group="skill"] .seg').forEach((b) => {
    b.addEventListener('click', () => { rivalSkill = b.dataset.skill as RivalSkill; syncSegs(); });
  });
  root.querySelectorAll<HTMLElement>('.strat-seg[data-group="laps"] .seg').forEach((b) => {
    b.addEventListener('click', () => { laps = Number(b.dataset.laps); syncSegs(); });
  });
  el.seed.addEventListener('change', () => { seed = Math.max(0, Math.floor(Number(el.seed.value) || 0)); });
  q('.seed-rand').addEventListener('click', () => {
    seed = Math.floor(Math.random() * 1e6);
    el.seed.value = String(seed);
  });
  q('.strat-race').addEventListener('click', () => {
    seed = Math.max(0, Math.floor(Number(el.seed.value) || 0));
    raceCb?.({ playerMap: clone(map), rivalSkill, laps, seed });
  });

  const redrawCharts = (): void => {
    if (lastProj) { drawSpeed(lastProj); drawSpark(lastProj); if (selectedZone != null) refreshZone(); }
  };

  // ============================================================ COACH LAYER

  /** Reflect the coach state (buttons, spinners, panels) into the DOM. */
  const updateCoachUI = (): void => {
    el.coachHeat.classList.toggle('active', heatmapOn);
    el.coachHeat.textContent = analyzing ? 'ANALYZING…' : heatmapOn ? 'SHOW MY MAP' : 'SHOW DEPLOY VALUE';
    el.coachHeat.disabled = analyzing;
    el.coachHeatLegend.hidden = !heatmapOn;
    el.coachSolving.hidden = !solving;
    el.coachSolve.disabled = solving;
    el.coachSolve.textContent = solving ? 'SOLVING…' : optimal ? 'RE-SOLVE' : 'SOLVE OPTIMAL';
    el.coachResult.hidden = !optimal || solving;
  };

  /** Build the signed, normalised per-zone heat values from the analysis. */
  const applyHeatmap = (): void => {
    if (!zoneAnalysis) { trackMap.setHeatmap(null); return; }
    const zs = zoneAnalysis.zones;
    const maxV = Math.max(1e-6, ...zs.map((z) => z.deployValueSec));
    const maxNeg = Math.max(1e-6, ...zs.map((z) => Math.max(0, -z.deployValueSec)));
    const signed = track.zones.map((zone) => {
      const zv = zs.find((z) => z.zoneId === zone.id);
      const dv = zv ? zv.deployValueSec : 0;
      return dv >= 0 ? dv / maxV : dv / maxNeg;
    });
    trackMap.setHeatmap(signed);
  };

  const toggleHeatmap = async (): Promise<void> => {
    heatmapOn = !heatmapOn;
    if (heatmapOn) {
      if (!zoneAnalysis) {
        analyzing = true;
        updateCoachUI();
        try { zoneAnalysis = await analyzeZones(track); }
        finally { analyzing = false; }
      }
      applyHeatmap();
    } else {
      trackMap.setHeatmap(null);
    }
    updateCoachUI();
    if (selectedZone != null) refreshZone(); // surface the zone's deployValueSec
  };

  const runSolve = async (): Promise<void> => {
    if (solving) return;
    solving = true;
    el.coachProgressBar.style.width = '0%';
    updateCoachUI();
    try {
      // the analysis feeds the "biggest gains" weights — fetch alongside (cached)
      const analysisP = zoneAnalysis ? Promise.resolve(zoneAnalysis) : analyzeZones(track);
      optimal = await solveOptimal(track, (f) => {
        el.coachProgressBar.style.width = `${Math.round(f * 100)}%`;
      });
      zoneAnalysis = await analysisP;
      optimalGhost = projectLap(track, optimal.map).speedSeries;
    } finally {
      solving = false;
    }
    updateCoachUI();
    updateCoach();
    redrawCharts(); // repaint the speed chart with the optimal ghost
  };

  /** Compare the user's map to the optimal map → top coaching differences. */
  interface Gain { text: string; detail: string; impact: number; cls: string }
  const buildGains = (): Gain[] => {
    if (!optimal) return [];
    const opt = optimal.map;
    const valueOf = (id: number): number =>
      zoneAnalysis?.zones.find((z) => z.zoneId === id)?.deployValueSec ?? 0;
    const gains: Gain[] = [];
    for (const zone of track.zones) {
      const id = zone.id;
      const du = map.zoneDeploy[id] ?? 0, dO = opt.zoneDeploy[id] ?? 0;
      const lu = map.zoneLift[id] ?? 0, lO = opt.zoneLift[id] ?? 0;
      const v = valueOf(id);
      if (dO - du > 0.1) {
        // optimal deploys more here than you → you're leaving this value on the table
        gains.push({ text: `Deploy in ${zone.name}`, detail: `+${Math.max(0, v).toFixed(1)}s`,
          impact: Math.max(0.05, v) * (dO - du), cls: 'is-add' });
      } else if (du - dO > 0.1) {
        // you deploy more than optimal → wasted if the zone has little/negative value
        if (v < 0.2) {
          gains.push({ text: `Stop deploying in ${zone.name}`, detail: v < 0 ? 'wasted' : 'low value',
            impact: (0.5 - v) * (du - dO), cls: 'is-cut' });
        } else {
          gains.push({ text: `Ease off deploy in ${zone.name}`, detail: 'save it',
            impact: 0.14 * (du - dO), cls: 'is-cut' });
        }
      }
      if (lO - lu > 0.1) {
        gains.push({ text: `Harvest more in ${zone.name}`, detail: 'bank charge',
          impact: 0.3 * (lO - lu), cls: 'is-harvest' });
      } else if (lu - lO > 0.1) {
        gains.push({ text: `Stop lifting in ${zone.name}`, detail: 'keep pace',
          impact: 0.16 * (lu - lO), cls: 'is-cut' });
      }
    }
    gains.sort((a, b) => b.impact - a.impact);
    return gains.slice(0, 3);
  };

  /** Refresh the "you vs optimal" panel + biggest-gains list (cheap; no sim). */
  const updateCoach = (): void => {
    if (!optimal) return;
    el.coachOptFlying.textContent = fmtLap(optimal.flyingLapTime);
    el.coachOptRace.textContent = fmtLap(optimal.lapTime);
    const userFlying = lastProj?.lapTime ?? NaN;
    el.coachYouFlying.textContent = fmtLap(userFlying);
    const onTable = Number.isFinite(userFlying) ? Math.max(0, userFlying - optimal.flyingLapTime) : NaN;
    el.coachGapVal.textContent = Number.isFinite(onTable) ? `${onTable.toFixed(2)}s` : '–';
    el.coachGapVal.classList.toggle('is-good', Number.isFinite(onTable) && onTable < 0.05);

    const gains = buildGains();
    if (gains.length === 0) {
      el.coachGainsList.innerHTML = '<li class="coach-gain is-match">You\'re matching the optimal map — nicely done.</li>';
    } else {
      el.coachGainsList.innerHTML = gains.map((gn) =>
        `<li class="coach-gain ${gn.cls}"><span class="cg-text">${gn.text}</span><span class="cg-detail">${gn.detail}</span></li>`
      ).join('');
    }
  };

  el.coachHeat.addEventListener('click', () => { void toggleHeatmap(); });
  el.coachSolve.addEventListener('click', () => { void runSolve(); });
  el.coachApply.addEventListener('click', () => {
    if (!optimal) return;
    map = cloneMap(optimal.map);
    trackMap.setMap(map);
    refreshZone();
    scheduleProjection();
    scheduleDelta();
    updateCoach();
  });

  const doResize = (): void => {
    const r = mapHost.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) trackMap.resize(r.width, r.height);
    redrawCharts();
  };
  window.addEventListener('resize', () => { if (root.style.display !== 'none') doResize(); });

  return {
    root,
    show(): void {
      root.style.display = 'flex';
      syncSegs();
      el.seed.value = String(seed);
      trackMap.setMap(map);
      trackMap.setSelected(selectedZone);
      if (heatmapOn) applyHeatmap(); else trackMap.setHeatmap(null);
      updateCoachUI();
      doResize();
      runProjection();
      if (optimal) updateCoach();
      if (selectedZone != null) scheduleDelta();
    },
    hide(): void {
      root.style.display = 'none';
      window.clearTimeout(projTimer);
      window.clearTimeout(deltaTimer);
    },
    render(): void {
      trackMap.render();
    },
    getSetup(): RaceSetup {
      return { playerMap: clone(map), rivalSkill, laps, seed };
    },
    getMap(): DeployMap {
      return clone(map);
    },
    setMap(m: DeployMap): void {
      map = clone(m);
      trackMap.setMap(map);
      refreshZone();
      scheduleProjection();
      scheduleDelta();
    },
    onRace(cb): void { raceCb = cb; },
  };
}
