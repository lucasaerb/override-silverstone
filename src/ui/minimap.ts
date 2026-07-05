/**
 * Canvas-2D minimap, top-left (~260 px): Silverstone outline projected from
 * track.samples (sim x/y, y-up -> canvas y-down flip), with sector ticks,
 * yellow Override detection-line + green activation-line notches, and a
 * visible START gap + S/F tick.
 *
 * Layers:
 *  - static track layer: prerendered ONCE to an offscreen canvas.
 *  - zone layer: per-TrackZone centerline stroke colored by the player's
 *    DeployMap (deploy level 0 skipped, 0.25 dim green -> 1.0 bright green;
 *    zones with zoneLift > 0 in blue). Redrawn only when the map changes.
 *  - per-frame: composite the two layers + car dots (player papaya with a
 *    white ring, rival teal).
 */
import type { CarState, DeployMap, TrackData } from '../sim/types';
import { trackAt } from '../sim/track';

export interface MinimapHandle {
  update(cars: CarState[], playerMap: DeployMap): void;
}

const SIZE = 260;
const PAD = 18;
/** samples skipped either side of s=0 so the loop shows a START gap */
const START_GAP_SAMPLES = 10;

export function createMinimap(container: HTMLElement, track: TrackData): MinimapHandle {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const canvas = document.createElement('canvas');
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  Object.assign(canvas.style, {
    position: 'absolute',
    top: '14px',
    left: '14px',
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    zIndex: '9',
    pointerEvents: 'none',
    background: 'rgba(9, 13, 19, 0.5)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: '12px',
    backdropFilter: 'blur(10px)',
  } satisfies Partial<CSSStyleDeclaration>);
  canvas.style.setProperty('-webkit-backdrop-filter', 'blur(10px)');
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('minimap: 2d context unavailable');
  ctx.scale(dpr, dpr);

  // ---- projection: fit sim x/y into the square, y flipped (canvas y down)
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const smp of track.samples) {
    if (smp.x < minX) minX = smp.x;
    if (smp.x > maxX) maxX = smp.x;
    if (smp.y < minY) minY = smp.y;
    if (smp.y > maxY) maxY = smp.y;
  }
  const scale = Math.min((SIZE - 2 * PAD) / (maxX - minX), (SIZE - 2 * PAD) / (maxY - minY));
  const cx = (SIZE - (maxX - minX) * scale) / 2;
  const cy = (SIZE - (maxY - minY) * scale) / 2;
  const px = (x: number): number => cx + (x - minX) * scale;
  const py = (y: number): number => cy + (maxY - y) * scale;

  const makeLayer = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const c = document.createElement('canvas');
    c.width = SIZE * dpr;
    c.height = SIZE * dpr;
    const g = c.getContext('2d');
    if (!g) throw new Error('minimap: 2d context unavailable');
    g.scale(dpr, dpr);
    return [c, g];
  };

  const tracePolyline = (
    g: CanvasRenderingContext2D, i0: number, i1: number,
  ): void => {
    // inclusive sample-index span; i1 may exceed count to wrap
    const n = track.samples.length;
    g.beginPath();
    for (let i = i0; i <= i1; i++) {
      const smp = track.samples[((i % n) + n) % n];
      const x = px(smp.x);
      const y = py(smp.y);
      if (i === i0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  };

  /** perpendicular tick across the track at arc length s */
  const tick = (
    g: CanvasRenderingContext2D, s: number, color: string, len: number, width: number,
  ): void => {
    const pose = trackAt(track, s);
    // sim left-normal in canvas px space (y flip negates the y component)
    const nx = pose.nx * scale;
    const ny = -pose.ny * scale;
    const mag = Math.hypot(nx, ny) || 1;
    const ux = nx / mag;
    const uy = ny / mag;
    const x = px(pose.x);
    const y = py(pose.y);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(x - ux * len, y - uy * len);
    g.lineTo(x + ux * len, y + uy * len);
    g.stroke();
  };

  // -------------------------------------------------- static track layer
  const [staticLayer] = ((): [HTMLCanvasElement] => {
    const [c, g] = makeLayer();
    const n = track.samples.length;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // subtle white edge under the asphalt stroke
    g.strokeStyle = 'rgba(225, 230, 236, 0.5)';
    g.lineWidth = 7;
    tracePolyline(g, START_GAP_SAMPLES, n - START_GAP_SAMPLES);
    g.strokeStyle = '#43464c';
    g.lineWidth = 5;
    tracePolyline(g, START_GAP_SAMPLES, n - START_GAP_SAMPLES);
    // sector boundaries
    tick(g, track.sector2S, 'rgba(255,255,255,0.85)', 5, 2);
    tick(g, track.sector3S, 'rgba(255,255,255,0.85)', 5, 2);
    // Override lines: yellow detection, green activation
    tick(g, track.detectionLineS, '#ffd43b', 6, 3);
    tick(g, track.activationLineS, '#3ddc84', 6, 3);
    // start/finish bar in the gap
    tick(g, 0, '#ffffff', 6, 3);
    return [c];
  })();

  // -------------------------------------------------- zone deploy layer
  const [zoneLayer, zoneCtx] = makeLayer();
  let zoneSig = '';

  const redrawZones = (map: DeployMap): void => {
    zoneCtx.clearRect(0, 0, SIZE, SIZE);
    zoneCtx.lineJoin = 'round';
    zoneCtx.lineCap = 'butt';
    zoneCtx.lineWidth = 3;
    for (const zone of track.zones) {
      const lift = map.zoneLift[zone.id] ?? 0;
      const deploy = map.zoneDeploy[zone.id] ?? 0;
      if (lift <= 0 && deploy <= 0) continue; // level 0 = none
      zoneCtx.strokeStyle = lift > 0
        ? `rgba(55, 166, 255, ${0.35 + 0.6 * lift})` // harvesting: blue
        : `rgba(46, 224, 122, ${0.18 + 0.82 * deploy})`; // deploy: dim -> bright green
      const i0 = Math.ceil(zone.sStart / track.ds);
      const i1 = Math.floor(Math.min(zone.sEnd, track.length - track.ds) / track.ds);
      if (i1 > i0) tracePolyline(zoneCtx, i0, i1);
    }
  };

  // -------------------------------------------------- per-frame composite
  const dot = (x: number, y: number, r: number, fill: string, ring?: string): void => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (ring) {
      ctx.strokeStyle = ring;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };

  return {
    update(cars: CarState[], playerMap: DeployMap): void {
      const sig = `${playerMap.zoneDeploy.join(',')}|${playerMap.zoneLift.join(',')}`;
      if (sig !== zoneSig) {
        zoneSig = sig;
        redrawZones(playerMap);
      }
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.drawImage(staticLayer, 0, 0, SIZE, SIZE);
      ctx.drawImage(zoneLayer, 0, 0, SIZE, SIZE);
      // rival first so the player dot draws on top
      for (const car of cars) {
        if (car.id === 'player') continue;
        const pose = trackAt(track, car.s);
        dot(
          px(pose.x + car.lateralOffset * pose.nx),
          py(pose.y + car.lateralOffset * pose.ny),
          4, '#2ab6b0', 'rgba(0,0,0,0.6)',
        );
      }
      const player = cars.find((c) => c.id === 'player');
      if (player) {
        const pose = trackAt(track, player.s);
        dot(
          px(pose.x + player.lateralOffset * pose.nx),
          py(pose.y + player.lateralOffset * pose.ny),
          5.5, '#ff8412', '#ffffff',
        );
      }
    },
  };
}
