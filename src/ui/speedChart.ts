/**
 * Speed-vs-distance line chart for the strategy screen. Plots the projected
 * flying-lap speed (km/h) across a distance window [sStart, sEnd] straight onto
 * a 2D canvas — dependency-free, DPR-aware, legible on the dark glass panels.
 *
 * On top of the speed trace it renders the same context the map paints: faint
 * zone-tint bands (green where deploy > 0, blue where lift > 0), an optional
 * secondary deploy-power line, sector dividers, and per-corner apex ticks with
 * min-speed dots. The whole-lap view (default) is the headline "see the speed
 * chart" element; passing a zone's [sStart, sEnd] zooms it to one section.
 */
import type { DeployMap, TrackData } from '../sim/types';

export interface SpeedChartOptions {
  /** speed (km/h) per track sample, indexed by i where s = i * track.ds */
  speedSeries: Float32Array;
  /** optional OPTIMAL-map speed (km/h) per sample, drawn as a faint dashed
   *  "ghost" behind the main trace so the player sees where the optimum carries
   *  more speed (i.e. where they are losing time). Same indexing as speedSeries. */
  ghostSpeedSeries?: Float32Array;
  track: TrackData;
  /** distance window start, m (default 0) */
  sStart?: number;
  /** distance window end, m (default track.length) */
  sEnd?: number;
  /** paints faint green (deploy) / blue (lift) tint bands behind the trace */
  deployMap?: DeployMap;
  /** overplots deploy power (W per sample) as a faint secondary line */
  powerSeries?: Float32Array;
  /** reserved for callers that want to overlay SoC; unused for now */
  socSeries?: Float32Array;
  /** draw corner apex ticks + min-speed dots (default true) */
  showCorners?: boolean;
}

const PAPAYA = '#ff8412';
const DEPLOY_GREEN = '46, 224, 122';
const LIFT_BLUE = '55, 166, 255';
const INK_DIM = 'rgba(154, 166, 180, 0.9)';

interface Surface {
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/** Size the backing store to the element's CSS box at device-pixel density. */
function surface(canvas: HTMLCanvasElement): Surface | null {
  const g = canvas.getContext('2d');
  if (!g) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(1, canvas.clientWidth || canvas.width);
  const cssH = Math.max(1, canvas.clientHeight || canvas.height);
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: cssW, h: cssH };
}

/** Round v up (dir=1) or down (dir=-1) to the nearest multiple of step. */
function roundTo(v: number, step: number, dir: 1 | -1): number {
  return dir > 0 ? Math.ceil(v / step) * step : Math.floor(v / step) * step;
}

/** A "nice" grid step (10/20/25/50/100…) for a target of ~4 lines over range. */
function niceStep(range: number): number {
  const raw = range / 4;
  const candidates = [10, 20, 25, 50, 100, 200];
  for (const c of candidates) if (raw <= c) return c;
  return 500;
}

/** Nearest sample value for arc length s (no interpolation — cheap + fine here). */
function sampleAt(series: Float32Array, ds: number, s: number): number {
  const i = Math.max(0, Math.min(series.length - 1, Math.round(s / ds)));
  return series[i];
}

/**
 * Draw a speed-vs-distance chart. Safe to call on every (debounced) projection
 * and on resize; it fully repaints the canvas.
 */
export function drawSpeedChart(canvas: HTMLCanvasElement, opts: SpeedChartOptions): void {
  const surf = surface(canvas);
  if (!surf) return;
  const { g, w, h } = surf;
  const { track, speedSeries, powerSeries, deployMap, ghostSpeedSeries } = opts;
  const ds = track.ds;
  const n = speedSeries.length;
  const sStart = Math.max(0, opts.sStart ?? 0);
  const sEnd = Math.min(track.length, opts.sEnd ?? track.length);
  const showCorners = opts.showCorners ?? true;
  const showLabels = sEnd - sStart < 2500; // only annotate corners when zoomed

  g.clearRect(0, 0, w, h);
  if (!(sEnd > sStart) || n < 2) return;

  // plot box
  const padL = 30, padR = 8, padT = 8, padB = 15;
  const plotX = padL, plotY = padT;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);

  const iStart = Math.max(0, Math.ceil(sStart / ds));
  const iEnd = Math.min(n - 1, Math.floor(sEnd / ds));

  // ---- y auto-scale over the visible window (include the ghost so it never clips)
  const hasGhost = !!ghostSpeedSeries && ghostSpeedSeries.length === n;
  let vMin = Infinity, vMax = -Infinity;
  for (let i = iStart; i <= iEnd; i++) {
    const v = speedSeries[i];
    if (Number.isFinite(v)) {
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    if (hasGhost) {
      const gv = ghostSpeedSeries![i];
      if (Number.isFinite(gv)) {
        if (gv < vMin) vMin = gv;
        if (gv > vMax) vMax = gv;
      }
    }
  }
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) return;
  const pad = (vMax - vMin) * 0.12 + 5;
  let yLo = Math.max(0, roundTo(vMin - pad, 20, -1));
  let yHi = roundTo(vMax + pad, 20, 1);
  if (yHi - yLo < 40) yHi = yLo + 40;

  const sx = (s: number): number => plotX + ((s - sStart) / (sEnd - sStart)) * plotW;
  const sy = (v: number): number => plotY + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

  // ---- zone tint bands (deploy green / lift blue) behind everything
  if (deployMap) {
    for (const zone of track.zones) {
      const zs = Math.max(zone.sStart, sStart);
      const ze = Math.min(zone.sEnd, sEnd);
      if (ze <= zs) continue;
      const deploy = deployMap.zoneDeploy[zone.id] ?? 0;
      const lift = deployMap.zoneLift[zone.id] ?? 0;
      if (deploy <= 0 && lift <= 0) continue;
      g.fillStyle = lift > 0
        ? `rgba(${LIFT_BLUE}, ${0.07 + 0.14 * lift})`
        : `rgba(${DEPLOY_GREEN}, ${0.06 + 0.15 * deploy})`;
      g.fillRect(sx(zs), plotY, sx(ze) - sx(zs), plotH);
    }
  }

  // ---- y grid + labels
  const step = niceStep(yHi - yLo);
  g.font = '600 9px ui-sans-serif, system-ui, sans-serif';
  g.textBaseline = 'middle';
  for (let v = yLo; v <= yHi + 0.5; v += step) {
    const y = sy(v);
    g.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(plotX, y);
    g.lineTo(plotX + plotW, y);
    g.stroke();
    g.fillStyle = INK_DIM;
    g.textAlign = 'right';
    g.fillText(String(v), plotX - 4, y);
  }

  // ---- sector dividers inside the window
  g.textAlign = 'center';
  g.setLineDash([3, 3]);
  for (const [s, label] of [[track.sector2S, 'S2'], [track.sector3S, 'S3']] as const) {
    if (s <= sStart || s >= sEnd) continue;
    const x = sx(s);
    g.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, plotY);
    g.lineTo(x, plotY + plotH);
    g.stroke();
    g.fillStyle = 'rgba(200, 208, 218, 0.7)';
    g.fillText(label, x, plotY + 6);
  }
  g.setLineDash([]);

  // ---- deploy power (0..350 kW) as a faint low band along the baseline, so it
  // shows where the MGU-K is spending without spiking across the whole chart
  if (powerSeries) {
    const bandH = plotH * 0.3;
    const base = plotY + plotH;
    g.beginPath();
    g.moveTo(sx(iStart * ds), base);
    let any = false;
    for (let i = iStart; i <= iEnd; i++) {
      const p = powerSeries[i];
      const frac = Number.isFinite(p) ? Math.max(0, Math.min(1, p / 350e3)) : 0;
      g.lineTo(sx(i * ds), base - frac * bandH);
      any = true;
    }
    g.lineTo(sx(iEnd * ds), base);
    g.closePath();
    if (any) { g.fillStyle = `rgba(${DEPLOY_GREEN}, 0.2)`; g.fill(); }
  }

  // ---- optimal "ghost" trace (dashed, dim) behind the user's line
  if (hasGhost) {
    g.setLineDash([4, 4]);
    g.beginPath();
    let started = false;
    for (let i = iStart; i <= iEnd; i++) {
      const gv = ghostSpeedSeries![i];
      if (!Number.isFinite(gv)) continue;
      const x = sx(i * ds), y = sy(gv);
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(184, 196, 210, 0.6)';
    g.lineWidth = 1.4;
    g.lineJoin = 'round';
    g.stroke();
    g.setLineDash([]);
  }

  // ---- speed area + line
  const grad = g.createLinearGradient(0, plotY, 0, plotY + plotH);
  grad.addColorStop(0, 'rgba(255, 132, 18, 0.26)');
  grad.addColorStop(1, 'rgba(255, 132, 18, 0.02)');
  g.beginPath();
  g.moveTo(sx(iStart * ds), plotY + plotH);
  for (let i = iStart; i <= iEnd; i++) g.lineTo(sx(i * ds), sy(speedSeries[i]));
  g.lineTo(sx(iEnd * ds), plotY + plotH);
  g.closePath();
  g.fillStyle = grad;
  g.fill();

  g.beginPath();
  for (let i = iStart; i <= iEnd; i++) {
    const x = sx(i * ds), y = sy(speedSeries[i]);
    if (i === iStart) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.strokeStyle = PAPAYA;
  g.lineWidth = 1.75;
  g.lineJoin = 'round';
  g.stroke();

  // ---- corner apex ticks + min-speed dots
  if (showCorners) {
    g.font = '700 8px ui-sans-serif, system-ui, sans-serif';
    for (const c of track.corners) {
      if (c.apexS < sStart || c.apexS > sEnd) continue;
      // min speed within the corner span, clamped to the window
      const lo = Math.max(iStart, Math.ceil(Math.max(c.sStart, sStart) / ds));
      const hi = Math.min(iEnd, Math.floor(Math.min(c.sEnd, sEnd) / ds));
      let minV = Infinity, minS = c.apexS;
      for (let i = lo; i <= hi; i++) {
        if (speedSeries[i] < minV) { minV = speedSeries[i]; minS = i * ds; }
      }
      if (!Number.isFinite(minV)) minV = sampleAt(speedSeries, ds, c.apexS);
      const x = sx(minS);
      // vertical tick
      g.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, plotY);
      g.lineTo(x, plotY + plotH);
      g.stroke();
      // dot
      const y = sy(minV);
      g.beginPath();
      g.arc(x, y, 2.6, 0, Math.PI * 2);
      g.fillStyle = PAPAYA;
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 1;
      g.stroke();
      if (showLabels) {
        g.fillStyle = 'rgba(232, 238, 245, 0.92)';
        g.textAlign = 'center';
        g.textBaseline = 'bottom';
        g.fillText(`${c.name} ${Math.round(minV)}`, x, y - 4);
        g.textBaseline = 'middle';
      }
    }
  }

  // ---- x meter labels (window bounds)
  g.font = '600 9px ui-sans-serif, system-ui, sans-serif';
  g.fillStyle = INK_DIM;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillText(`${Math.round(sStart)} m`, plotX + 1, h - 3);
  g.textAlign = 'right';
  g.fillText(`${Math.round(sEnd)} m`, plotX + plotW, h - 3);
}

/** Interpolated speed (km/h) at an arbitrary arc length — for exit-speed readouts. */
export function speedAtS(series: Float32Array, track: TrackData, s: number): number {
  const ds = track.ds;
  const n = series.length;
  const sw = ((s % track.length) + track.length) % track.length;
  const i0 = Math.min(Math.floor(sw / ds), n - 1);
  const i1 = (i0 + 1) % n;
  const f = sw / ds - i0;
  return series[i0] + (series[i1] - series[i0]) * f;
}
