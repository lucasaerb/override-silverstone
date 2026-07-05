/**
 * Interactive 2D Silverstone map. Draws the circuit from track.samples with
 * each of the 19 deploy zones painted by the current DeployMap (green = deploy
 * level, blue = lift/harvest), plus corner labels, sector ticks and the
 * Override detection/activation lines. Clicking a zone cycles its setting.
 *
 * Reused by the full-screen strategy screen AND the non-pausing in-race
 * live-edit overlay, so it owns only its canvas + painting + hit-testing;
 * layout and the projection panel live in the caller.
 *
 * Hit-testing maps a pointer to the nearest centerline sample → its arc length
 * → the zone whose [sStart, sEnd) span contains it. Robust regardless of zone
 * shape.
 */
import type { CarState, DeployMap, TrackData, TrackZone } from '../sim/types';
import { trackAt } from '../sim/track';

export const DEPLOY_STEPS = [0, 0.25, 0.5, 0.75, 1] as const;

export type EditKind = 'deploy' | 'lift';

/** Curated orientation labels (name → arc length). Fewer than 19 to stay legible. */
const KEY_LABELS: Array<{ name: string; s: number }> = [
  { name: 'ABBEY', s: 395 },
  { name: 'VILLAGE', s: 894 },
  { name: 'THE LOOP', s: 1044 },
  { name: 'WELLINGTON', s: 1550 },
  { name: 'BROOKLANDS', s: 2004 },
  { name: 'LUFFIELD', s: 2179 },
  { name: 'COPSE', s: 3133 },
  { name: 'MAGGOTTS', s: 3560 },
  { name: 'BECKETTS', s: 3900 },
  { name: 'HANGAR', s: 4600 },
  { name: 'STOWE', s: 5083 },
  { name: 'VALE', s: 5517 },
  { name: 'CLUB', s: 5650 },
];

function deployColor(level: number): string {
  return `rgba(46, 224, 122, ${0.22 + 0.78 * level})`;
}
function liftColor(level: number): string {
  return `rgba(55, 166, 255, ${0.3 + 0.7 * level})`;
}

/**
 * Deploy-value heat colour for a signed, normalised value in ~[-1, 1]:
 *  v > 0  → green ramp (bright green = high value, deploy here; dim = low value)
 *  v < 0  → faint red   (deploying here WASTES lap time)
 */
function heatColor(v: number): string {
  if (v >= 0) {
    const t = Math.min(1, v);
    return `rgba(46, 224, 122, ${0.16 + 0.82 * t})`;
  }
  const t = Math.min(1, -v);
  return `rgba(255, 90, 90, ${0.22 + 0.55 * t})`;
}

export interface TrackMapOptions {
  interactive?: boolean;
  showLabels?: boolean;
  /** stroke width of the painted zones, px (base) */
  zoneWidth?: number;
}

export class TrackMap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly track: TrackData;
  private readonly opts: Required<TrackMapOptions>;

  private w = 300;
  private h = 300;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  // projection sim(x,y) → canvas(px,py)
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private readonly minX: number;
  private readonly maxY: number;
  private readonly bbox: { minX: number; maxX: number; minY: number; maxY: number };

  // cached projected sample coords for hit-testing
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);

  private base: HTMLCanvasElement;
  private map: DeployMap | null = null;
  private heatmap: number[] | null = null;
  private hover: number | null = null;
  private selected: number | null = null;
  private cars: CarState[] | null = null;
  private editCb: ((zoneId: number, kind: EditKind) => void) | null = null;
  private selectCb: ((zoneId: number) => void) | null = null;

  constructor(track: TrackData, opts: TrackMapOptions = {}) {
    this.track = track;
    this.opts = {
      interactive: opts.interactive ?? true,
      showLabels: opts.showLabels ?? true,
      zoneWidth: opts.zoneWidth ?? 6,
    };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const s of track.samples) {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
    }
    this.bbox = { minX, maxX, minY, maxY };
    this.minX = minX;
    this.maxY = maxY;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'trackmap-canvas';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('trackMap: 2d context unavailable');
    this.ctx = ctx;
    this.base = document.createElement('canvas');

    if (this.opts.interactive) this.attachInput();
  }

  onEdit(cb: (zoneId: number, kind: EditKind) => void): void {
    this.editCb = cb;
  }

  /** Fired on any click (left or right) with the hit zone — for callers that
   * want to SELECT a zone in addition to the deploy/lift cycle onEdit does.
   * Optional: the in-race overlay leaves it unset and is unaffected. */
  onSelect(cb: (zoneId: number) => void): void {
    this.selectCb = cb;
  }

  /** Highlight one zone with a bright papaya outline (or clear with null). */
  setSelected(zoneId: number | null): void {
    this.selected = zoneId;
  }

  setMap(map: DeployMap): void {
    this.map = map;
  }

  /**
   * Switch the zone painting into deploy-VALUE heat-map mode. `values` is one
   * signed, normalised value per zone (index = zone id), roughly in [-1, 1]:
   * positive = lap time saved by deploying here (green ramp), negative = time
   * wasted (faint red). Pass `null` to return to the normal deploy-map colours.
   */
  setHeatmap(values: number[] | null): void {
    this.heatmap = values;
  }

  setCars(cars: CarState[] | null): void {
    this.cars = cars;
  }

  /** Fit the map to a pixel box; rebuilds the projection + static base layer. */
  resize(w: number, h: number): void {
    this.w = Math.max(80, Math.floor(w));
    this.h = Math.max(80, Math.floor(h));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.canvas, this.base]) {
      c.width = this.w * this.dpr;
      c.height = this.h * this.dpr;
    }
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;

    const pad = 34;
    const spanX = this.bbox.maxX - this.bbox.minX;
    const spanY = this.bbox.maxY - this.bbox.minY;
    this.scale = Math.min((this.w - 2 * pad) / spanX, (this.h - 2 * pad) / spanY);
    this.ox = (this.w - spanX * this.scale) / 2;
    this.oy = (this.h - spanY * this.scale) / 2;

    const n = this.track.samples.length;
    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.sx[i] = this.px(this.track.samples[i].x);
      this.sy[i] = this.py(this.track.samples[i].y);
    }
    this.drawBase();
  }

  private px(x: number): number {
    return this.ox + (x - this.minX) * this.scale;
  }
  private py(y: number): number {
    return this.oy + (this.maxY - y) * this.scale;
  }

  setHover(zoneId: number | null): void {
    this.hover = zoneId;
  }

  /** Composite: static base + painted zones + hover highlight + car dots. */
  render(): void {
    const g = this.ctx;
    g.save();
    g.scale(this.dpr, this.dpr);
    g.clearRect(0, 0, this.w, this.h);
    g.drawImage(this.base, 0, 0, this.w, this.h);
    if (this.heatmap) this.drawHeatmap(g, this.heatmap);
    else if (this.map) this.drawZones(g, this.map);
    if (this.hover != null && this.hover !== this.selected) this.drawHover(g, this.hover);
    if (this.selected != null) this.drawSelected(g, this.selected);
    if (this.cars) this.drawCars(g);
    g.restore();
  }

  // ---------------------------------------------------------------- layers

  private tracePolyline(g: CanvasRenderingContext2D, i0: number, i1: number): void {
    const n = this.track.samples.length;
    g.beginPath();
    for (let i = i0; i <= i1; i++) {
      const j = ((i % n) + n) % n;
      if (i === i0) g.moveTo(this.sx[j], this.sy[j]);
      else g.lineTo(this.sx[j], this.sy[j]);
    }
    g.stroke();
  }

  private tickMark(g: CanvasRenderingContext2D, s: number, color: string, len: number, width: number): void {
    const pose = trackAt(this.track, s);
    let nx = pose.nx * this.scale;
    let ny = -pose.ny * this.scale;
    const mag = Math.hypot(nx, ny) || 1;
    nx /= mag; ny /= mag;
    const x = this.px(pose.x), y = this.py(pose.y);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(x - nx * len, y - ny * len);
    g.lineTo(x + nx * len, y + ny * len);
    g.stroke();
  }

  private drawBase(): void {
    const g = this.base.getContext('2d');
    if (!g) return;
    g.save();
    g.scale(this.dpr, this.dpr);
    g.clearRect(0, 0, this.w, this.h);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const n = this.track.samples.length;
    const bw = this.opts.zoneWidth;

    // asphalt base: light edge under a dark ribbon
    g.strokeStyle = 'rgba(210, 216, 224, 0.32)';
    g.lineWidth = bw + 5;
    this.tracePolyline(g, 0, n - 1);
    g.strokeStyle = 'rgba(38, 42, 49, 0.95)';
    g.lineWidth = bw + 2;
    this.tracePolyline(g, 0, n - 1);

    // sector ticks + Override lines + S/F
    this.tickMark(g, this.track.sector2S, 'rgba(255,255,255,0.6)', bw + 4, 2);
    this.tickMark(g, this.track.sector3S, 'rgba(255,255,255,0.6)', bw + 4, 2);
    this.tickMark(g, this.track.detectionLineS, '#ffd43b', bw + 6, 3);
    this.tickMark(g, this.track.activationLineS, '#3ddc84', bw + 6, 3);
    this.tickMark(g, 0, '#ffffff', bw + 7, 4);

    if (this.opts.showLabels) this.drawLabels(g);
    g.restore();
  }

  private drawLabels(g: CanvasRenderingContext2D): void {
    g.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const lbl of KEY_LABELS) {
      const pose = trackAt(this.track, lbl.s);
      // push the label outward (opposite the turn direction) off the track
      const outSign = pose.kappa > 0 ? -1 : 1;
      let nx = pose.nx * outSign, ny = -pose.ny * outSign;
      const mag = Math.hypot(nx, ny) || 1;
      nx /= mag; ny /= mag;
      const x = this.px(pose.x) + nx * 20;
      const y = this.py(pose.y) + ny * 20;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      const w = g.measureText(lbl.name).width + 8;
      g.fillRect(x - w / 2, y - 7, w, 14);
      g.fillStyle = 'rgba(232, 238, 245, 0.92)';
      g.fillText(lbl.name, x, y);
    }
  }

  private zoneSpanIndices(zone: TrackZone): [number, number] {
    const ds = this.track.ds;
    const n = this.track.samples.length;
    const i0 = Math.ceil(zone.sStart / ds);
    const i1 = Math.min(n - 1, Math.floor((zone.sEnd - 1e-3) / ds));
    return [i0, i1];
  }

  private drawZones(g: CanvasRenderingContext2D, map: DeployMap): void {
    g.lineJoin = 'round';
    g.lineCap = 'butt';
    g.lineWidth = this.opts.zoneWidth;
    for (const zone of this.track.zones) {
      const deploy = map.zoneDeploy[zone.id] ?? 0;
      const lift = map.zoneLift[zone.id] ?? 0;
      if (deploy <= 0 && lift <= 0) continue;
      g.strokeStyle = lift > 0 ? liftColor(lift) : deployColor(deploy);
      const [i0, i1] = this.zoneSpanIndices(zone);
      if (i1 > i0) this.tracePolyline(g, i0, i1);
    }
  }

  /** Paint EVERY zone by its deploy-value (evidence heat-map). */
  private drawHeatmap(g: CanvasRenderingContext2D, values: number[]): void {
    g.lineJoin = 'round';
    g.lineCap = 'butt';
    g.lineWidth = this.opts.zoneWidth + 1;
    for (const zone of this.track.zones) {
      const v = values[zone.id] ?? 0;
      g.strokeStyle = heatColor(v);
      const [i0, i1] = this.zoneSpanIndices(zone);
      if (i1 > i0) this.tracePolyline(g, i0, i1);
    }
  }

  private drawHover(g: CanvasRenderingContext2D, zoneId: number): void {
    const zone = this.track.zones[zoneId];
    if (!zone) return;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = this.opts.zoneWidth + 4;
    const [i0, i1] = this.zoneSpanIndices(zone);
    if (i1 > i0) this.tracePolyline(g, i0, i1);
  }

  private drawSelected(g: CanvasRenderingContext2D, zoneId: number): void {
    const zone = this.track.zones[zoneId];
    if (!zone) return;
    const [i0, i1] = this.zoneSpanIndices(zone);
    if (i1 <= i0) return;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // outer papaya halo, then a bright inner stroke (thicker than hover)
    g.strokeStyle = 'rgba(255, 132, 18, 0.35)';
    g.lineWidth = this.opts.zoneWidth + 10;
    this.tracePolyline(g, i0, i1);
    g.strokeStyle = '#ff8412';
    g.lineWidth = this.opts.zoneWidth + 3;
    this.tracePolyline(g, i0, i1);
  }

  private drawCars(g: CanvasRenderingContext2D): void {
    if (!this.cars) return;
    const dot = (car: CarState, r: number, fill: string, ring: string): void => {
      const pose = trackAt(this.track, car.s);
      const x = this.px(pose.x + car.lateralOffset * pose.nx);
      const y = this.py(pose.y + car.lateralOffset * pose.ny);
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = ring;
      g.lineWidth = 2;
      g.stroke();
    };
    for (const car of this.cars) if (car.id === 'rival') dot(car, 4.5, '#2ab6b0', 'rgba(0,0,0,0.6)');
    const p = this.cars.find((c) => c.id === 'player');
    if (p) dot(p, 6, '#ff8412', '#ffffff');
  }

  // ---------------------------------------------------------------- input

  /** Nearest zone to a client-space point, or null if the pointer is off-track. */
  zoneAt(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.sx.length; i++) {
      const dx = this.sx[i] - x;
      const dy = this.sy[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > 26 * 26) return null;
    const s = best * this.track.ds;
    for (const zone of this.track.zones) {
      if (s >= zone.sStart && s < zone.sEnd) return zone.id;
    }
    return this.track.zones.length - 1;
  }

  private attachInput(): void {
    this.canvas.addEventListener('mousemove', (e) => {
      this.setHover(this.zoneAt(e.clientX, e.clientY));
    });
    this.canvas.addEventListener('mouseleave', () => this.setHover(null));
    this.canvas.addEventListener('click', (e) => {
      const id = this.zoneAt(e.clientX, e.clientY);
      if (id == null) return;
      this.editCb?.(id, 'deploy');
      this.selectCb?.(id);
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const id = this.zoneAt(e.clientX, e.clientY);
      if (id == null) return;
      this.editCb?.(id, 'lift');
      this.selectCb?.(id);
    });
  }
}

/** Cycle a level through DEPLOY_STEPS (0→.25→.5→.75→1→0). */
export function cycleLevel(current: number): number {
  const i = DEPLOY_STEPS.findIndex((v) => Math.abs(v - current) < 1e-3);
  return DEPLOY_STEPS[(i + 1) % DEPLOY_STEPS.length];
}
