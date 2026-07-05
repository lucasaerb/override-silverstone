/**
 * Realistic-proportioned 2026 F1 car, built entirely from Three primitives
 * merged with BufferGeometryUtils into FOUR draw calls per car:
 *
 *   1. livery mesh  — all painted bodywork (nose, tub, sidepods w/ undercut,
 *      engine cover + shark fin, 3-element front wing + endplates, swan-neck
 *      rear wing + beam wing, mirrors, airbox, T-cam pod, helmet), one merged
 *      geometry UV-mapped into a single generated 1024² canvas atlas
 *      (per-livery colors, number plates, fictional sponsor typography) with
 *      a matching roughness map (glossy paint vs matte panels).
 *   2. carbon mesh  — vertex-colored technical parts: floor + plank + edge
 *      wings, diffuser + strakes, matte-titanium halo (torus arc + struts),
 *      suspension wishbones/pushrods (thin cylinders), brake ducts, cockpit
 *      interior, headrest, HANS/shoulders, gloved hands + steering wheel.
 *   3. wheels       — ONE InstancedMesh (4 instances) of a lathe-profile 18"
 *      tire+rim with a generated texture: tread, sidewall branding ring,
 *      compound ring, flat spoke pattern on the rim face; metal/roughness
 *      channels painted per band. Spin + front steer via instance matrices.
 *   4. glow mesh    — FIA rain-light block + diffuser strip, emissive red;
 *      setBoostGlow pulses it when deploying (restrained, game-legible).
 *
 * Local conventions match the old demoCar: nose along +Z, up +Y, ground at
 * y = 0. 2026 regulation proportions: ~5.14 m long, 1.90 m wide incl. wheels,
 * 3.40 m wheelbase, low nose, narrow rear wing. ~9k triangles per car.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeCanvasTexture, mulberry32 } from './utils';

export type LiveryId = 'player' | 'rival';

export interface CarModelHandle {
  root: THREE.Group;
  /** place the car: world position (ground level), unit forward, roll (rad) */
  setPose(position: THREE.Vector3, forward: THREE.Vector3, roll: number): void;
  /** advance wheel rotation by a distance traveled, m */
  spinWheels(distance: number): void;
  /** visual front-wheel steer, rad — feed it curvature * wheelbase */
  setSteer(angle: number): void;
  /** rain-light / diffuser emissive pulse while deploying */
  setBoostGlow(active: boolean): void;
  /** build-time stat for perf reporting */
  triangleCount: number;
}

// ------------------------------------------------------------- dimensions

const WHEELBASE = 3.4;
const AXLE = WHEELBASE / 2; // axles at z = ±1.7
const TIRE_R = 0.36; // 18" wheel, ~720 mm OD (width 0.38 via WHEEL_PROFILE)
const WHEEL_X = 0.76; // outer face at ±0.95 -> overall width 1.90
const MAX_STEER = 0.45;

// ------------------------------------------------------------- liveries

interface Palette {
  base: string;
  base2: string;
  dark: string;
  accent: string;
  number: string;
  /** T-cam pod: black on player, broadcast yellow on rival (real T-cam code) */
  pod: string;
  helmet: string;
  helmetStripe: string;
  glove: string;
}

const PALETTES: Record<LiveryId, Palette> = {
  player: {
    base: '#ff7a14', base2: '#cf5c06', dark: '#141518', accent: '#ffffff',
    number: '1', pod: '#0d0e11', helmet: '#f4f6f8', helmetStripe: '#ff7a14',
    glove: '#ff7a14',
  },
  rival: {
    base: '#0e6b72', base2: '#0a4a50', dark: '#0d0f12', accent: '#c9ced6',
    number: '11', pod: '#ffc400', helmet: '#c9ced6', helmetStripe: '#0e6b72',
    glove: '#12878f',
  },
};

/** fictional sponsor-style marks — no real brands/teams/drivers */
const SPONSORS = ['VOLTARC', 'KESTREL', 'AERION', 'NIMBUS', 'HALCYON', 'PULSE-9', 'ORBITAL', 'ZEPHYR'];

// ------------------------------------------------------------- UV atlas

/** atlas rect [u0, v0, u1, v1]; small insets fight mip bleed between regions */
type Rect = readonly [number, number, number, number];

const R_BODY: Rect = [0.005, 0.505, 0.495, 0.995]; // sidepods / engine cover / tub
const R_NOSE: Rect = [0.505, 0.505, 0.995, 0.995];
const R_WING: Rect = [0.005, 0.255, 0.495, 0.495];
const R_NUMBER: Rect = [0.505, 0.255, 0.995, 0.495]; // number plate panel
const R_COCKPIT: Rect = [0.005, 0.005, 0.235, 0.235]; // matte anti-glare
const R_POD: Rect = [0.255, 0.005, 0.485, 0.235]; // T-cam
const R_ACCENT: Rect = [0.505, 0.005, 0.745, 0.235];
const R_HELMET: Rect = [0.755, 0.005, 0.995, 0.235];

/**
 * Remap a geometry's [0,1] UVs into atlas rect `r`. `mirrorU` reflects u
 * before remapping — used on wrapped revolve surfaces (capsules) whose default
 * winding puts the readable side of the texture facing INWARD, which renders
 * sponsor text mirrored on the outboard (camera-facing) half. Flipping u once
 * brings the readable side outboard on both left/right panels.
 */
function remapUV(g: THREE.BufferGeometry, r: Rect, mirrorU = false): THREE.BufferGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const u = mirrorU ? 1 - uv.getX(i) : uv.getX(i);
    uv.setXY(i, r[0] + u * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
  }
  return g;
}

/**
 * BoxGeometry faces are 4 verts each in order +x, -x, +y, -y, +z, -z. Three's
 * default per-face UVs run u in OPPOSITE directions on the +x vs -x (and +z vs
 * -z) faces, so an identical text rect reads correctly on one and mirrored on
 * the opposite one. `flip` (per-face) reflects u within that face so number
 * plates read left-to-right on BOTH sides.
 */
function boxFaceUV(
  g: THREE.BoxGeometry,
  rects: readonly [Rect, Rect, Rect, Rect, Rect, Rect],
  flip: readonly [boolean, boolean, boolean, boolean, boolean, boolean] = [false, false, false, false, false, false],
): THREE.BoxGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let f = 0; f < 6; f++) {
    const r = rects[f];
    for (let i = f * 4; i < f * 4 + 4; i++) {
      const u = flip[f] ? 1 - uv.getX(i) : uv.getX(i);
      uv.setXY(i, r[0] + u * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
    }
  }
  return g;
}

// ------------------------------------------------------------- geo helpers

interface Xf {
  s?: readonly [number, number, number];
  rx?: number;
  ry?: number;
  rz?: number;
  p?: readonly [number, number, number];
}

/** scale -> rotateX -> rotateY -> rotateZ -> translate, in place */
function xf<T extends THREE.BufferGeometry>(g: T, o: Xf): T {
  if (o.s) g.scale(o.s[0], o.s[1], o.s[2]);
  if (o.rx) g.rotateX(o.rx);
  if (o.ry) g.rotateY(o.ry);
  if (o.rz) g.rotateZ(o.rz);
  if (o.p) g.translate(o.p[0], o.p[1], o.p[2]);
  return g;
}

/** thin cylinder from a to b (suspension arms, halo struts, mirror stalks) */
function rod(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number,
): THREE.BufferGeometry {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, 7, 1, true);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate(ax, ay, az);
  return g;
}

/** vertex-color a geometry (sRGB hex -> linear) for the carbon material */
function tint(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex).convertSRGBToLinear();
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// ------------------------------------------------------------- textures

const ATLAS = 1024;

function rectPx(r: Rect, size: number): { x: number; y: number; w: number; h: number } {
  // CanvasTexture flipY: v=0 is the canvas BOTTOM row
  return {
    x: r[0] * size,
    y: (1 - r[3]) * size,
    w: (r[2] - r[0]) * size,
    h: (r[3] - r[1]) * size,
  };
}

function text(
  ctx: CanvasRenderingContext2D,
  str: string, x: number, y: number, sizePx: number, fill: string, rot = 0, italic = true,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.font = `${italic ? 'italic ' : ''}800 ${sizePx}px ui-sans-serif, -apple-system, 'Helvetica Neue', Arial, sans-serif`;
  ctx.fillStyle = fill;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, 0, 0);
  ctx.restore();
}

function paintLiveryAtlas(p: Palette): (ctx: CanvasRenderingContext2D) => void {
  return (ctx) => {
    const rng = mulberry32(p.number === '1' ? 11 : 47);
    ctx.fillStyle = p.dark;
    ctx.fillRect(0, 0, ATLAS, ATLAS);

    // ---- BODY: flowing base livery + dark belly swoosh + sponsors
    {
      const r = rectPx(R_BODY, ATLAS);
      const grad = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
      grad.addColorStop(0, p.base);
      grad.addColorStop(1, p.base2);
      ctx.fillStyle = grad;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      // dark swoosh across the lower band
      ctx.fillStyle = p.dark;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y + r.h * 0.66);
      ctx.bezierCurveTo(r.x + r.w * 0.3, r.y + r.h * 0.52, r.x + r.w * 0.6, r.y + r.h * 0.82, r.x + r.w, r.y + r.h * 0.70);
      ctx.lineTo(r.x + r.w, r.y + r.h);
      ctx.lineTo(r.x, r.y + r.h);
      ctx.closePath();
      ctx.fill();
      // accent pinstripe along the swoosh
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y + r.h * 0.66);
      ctx.bezierCurveTo(r.x + r.w * 0.3, r.y + r.h * 0.52, r.x + r.w * 0.6, r.y + r.h * 0.82, r.x + r.w, r.y + r.h * 0.70);
      ctx.stroke();
      // faint panel shutlines
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 2;
      for (const fx of [0.22, 0.48, 0.74]) {
        ctx.beginPath();
        ctx.moveTo(r.x + r.w * fx, r.y);
        ctx.lineTo(r.x + r.w * (fx + 0.04), r.y + r.h);
        ctx.stroke();
      }
      // sponsor typography, mixed orientations so any UV flow reads as design
      const marks: Array<[number, number, number, number, string]> = [
        [0.18, 0.25, 34, 0, p.dark],
        [0.55, 0.18, 30, 0, p.dark],
        [0.85, 0.30, 26, Math.PI / 2, p.dark],
        [0.30, 0.80, 30, 0, p.accent],
        [0.70, 0.86, 26, 0, p.accent],
        [0.06, 0.55, 24, -Math.PI / 2, p.dark],
        [0.94, 0.72, 24, Math.PI / 2, p.accent],
        [0.45, 0.45, 24, 0, p.dark],
      ];
      marks.forEach(([fx, fy, size, rot, fill], i) => {
        text(ctx, SPONSORS[i % SPONSORS.length], r.x + r.w * fx, r.y + r.h * fy, size, fill, rot);
      });
      // small number roundel on the body flow
      ctx.fillStyle = p.accent;
      ctx.beginPath();
      ctx.arc(r.x + r.w * 0.62, r.y + r.h * 0.60, 34, 0, Math.PI * 2);
      ctx.fill();
      text(ctx, p.number, r.x + r.w * 0.62, r.y + r.h * 0.60, 44, p.dark, 0, false);
    }

    // ---- NOSE: stripes along length, roundel + number near the tip (v=1 top)
    {
      const r = rectPx(R_NOSE, ATLAS);
      const grad = ctx.createLinearGradient(r.x, r.y + r.h, r.x, r.y);
      grad.addColorStop(0, p.base2);
      grad.addColorStop(1, p.base);
      ctx.fillStyle = grad;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      // lengthwise accent stripes (vertical in canvas = along the nose)
      ctx.fillStyle = p.dark;
      ctx.fillRect(r.x + r.w * 0.46, r.y, r.w * 0.08, r.h);
      ctx.fillStyle = p.accent;
      ctx.fillRect(r.x + r.w * 0.435, r.y, r.w * 0.018, r.h);
      ctx.fillRect(r.x + r.w * 0.547, r.y, r.w * 0.018, r.h);
      // tip chevron
      ctx.fillStyle = p.dark;
      ctx.fillRect(r.x, r.y, r.w, r.h * 0.06);
      // number roundels (twice around the circumference so the top always shows one)
      for (const fx of [0.25, 0.75]) {
        ctx.fillStyle = p.accent;
        ctx.beginPath();
        ctx.arc(r.x + r.w * fx, r.y + r.h * 0.22, 56, 0, Math.PI * 2);
        ctx.fill();
        text(ctx, p.number, r.x + r.w * fx, r.y + r.h * 0.23, 76, p.dark, 0, false);
      }
      text(ctx, SPONSORS[0], r.x + r.w * 0.25, r.y + r.h * 0.62, 30, p.accent, Math.PI / 2);
      text(ctx, SPONSORS[1], r.x + r.w * 0.75, r.y + r.h * 0.62, 30, p.accent, -Math.PI / 2);
    }

    // ---- WING: carbon with painted tips + accent span stripe
    {
      const r = rectPx(R_WING, ATLAS);
      ctx.fillStyle = '#1a1c20';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      // carbon streaks
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      for (let i = 0; i < 60; i++) {
        ctx.fillRect(r.x + rng() * r.w, r.y + rng() * r.h, 2, 10 + rng() * 30);
      }
      // painted wingtips (u extremes = span ends on the planes)
      const tip = r.w * 0.13;
      const tgrad = ctx.createLinearGradient(r.x, 0, r.x + tip, 0);
      tgrad.addColorStop(0, p.base);
      tgrad.addColorStop(1, p.base2);
      ctx.fillStyle = tgrad;
      ctx.fillRect(r.x, r.y, tip, r.h);
      ctx.fillRect(r.x + r.w - tip, r.y, tip, r.h);
      ctx.fillStyle = p.accent;
      ctx.fillRect(r.x + tip, r.y, 6, r.h);
      ctx.fillRect(r.x + r.w - tip - 6, r.y, 6, r.h);
      text(ctx, SPONSORS[2], r.x + r.w * 0.5, r.y + r.h * 0.5, 34, p.accent);
    }

    // ---- NUMBER plate panel (shark fin sides, rear-wing endplates)
    {
      const r = rectPx(R_NUMBER, ATLAS);
      ctx.fillStyle = p.accent;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = p.base;
      ctx.fillRect(r.x, r.y, r.w, r.h * 0.14);
      ctx.fillRect(r.x, r.y + r.h * 0.86, r.w, r.h * 0.14);
      text(ctx, p.number, r.x + r.w * 0.5, r.y + r.h * 0.5, 210, p.dark, 0, false);
      text(ctx, SPONSORS[3], r.x + r.w * 0.5, r.y + r.h * 0.80, 26, p.dark);
    }

    // ---- COCKPIT matte anti-glare
    {
      const r = rectPx(R_COCKPIT, ATLAS);
      ctx.fillStyle = '#0b0c0e';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      for (let i = 0; i < 40; i++) ctx.fillRect(r.x + rng() * r.w, r.y + rng() * r.h, 3, 3);
    }

    // ---- T-cam POD
    {
      const r = rectPx(R_POD, ATLAS);
      ctx.fillStyle = p.pod;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(r.x + r.w * 0.1, r.y + r.h * 0.38, r.w * 0.16, r.h * 0.24); // lens
      ctx.fillRect(r.x + r.w * 0.74, r.y + r.h * 0.38, r.w * 0.16, r.h * 0.24);
    }

    // ---- ACCENT solid
    {
      const r = rectPx(R_ACCENT, ATLAS);
      const g2 = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
      g2.addColorStop(0, p.accent);
      g2.addColorStop(1, p.base2);
      ctx.fillStyle = g2;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }

    // ---- HELMET: base + stripes + wraparound visor band
    {
      const r = rectPx(R_HELMET, ATLAS);
      ctx.fillStyle = p.helmet;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = p.helmetStripe;
      ctx.fillRect(r.x, r.y + r.h * 0.10, r.w, r.h * 0.10);
      ctx.fillRect(r.x, r.y + r.h * 0.66, r.w, r.h * 0.08);
      ctx.fillStyle = p.dark;
      ctx.fillRect(r.x, r.y + r.h * 0.30, r.w, r.h * 0.22); // visor band
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(r.x, r.y + r.h * 0.33, r.w, r.h * 0.03); // visor glint
      text(ctx, p.number, r.x + r.w * 0.5, r.y + r.h * 0.85, 34, p.helmetStripe, 0, false);
    }
  };
}

/** roughness map (green channel) matching the atlas regions */
function paintLiveryRough(): (ctx: CanvasRenderingContext2D) => void {
  const S = 256;
  const fill = (ctx: CanvasRenderingContext2D, r: Rect, v: number): void => {
    const q = rectPx(r, S);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(q.x, q.y, q.w, q.h);
  };
  return (ctx) => {
    ctx.fillStyle = 'rgb(95,95,95)'; // glossy clearcoat paint ~0.37
    ctx.fillRect(0, 0, S, S);
    fill(ctx, R_WING, 125);
    fill(ctx, R_NUMBER, 100);
    fill(ctx, R_COCKPIT, 200); // matte anti-glare
    fill(ctx, R_POD, 150);
    fill(ctx, R_HELMET, 70); // glossy helmet
  };
}

// wheel texture bands: lathe v = point index / (points-1); flipY -> y=(1-v)*S
const WHEEL_PROFILE: Array<[number, number]> = [
  [0.055, -0.160], // 0 inboard hub
  [0.225, -0.176], // 1 inboard rim lip
  [0.300, -0.186], // 2 inboard sidewall bulge
  [0.352, -0.152], // 3 inboard shoulder
  [0.365, 0.0],    // 4 tread crown
  [0.352, 0.152],  // 5 outboard shoulder
  [0.300, 0.186],  // 6 outboard sidewall (branding)
  [0.225, 0.176],  // 7 outboard rim lip
  [0.055, 0.160],  // 8 rim face (spokes)
];

function wheelBandY(i0: number, i1: number, S: number): [number, number] {
  const n = WHEEL_PROFILE.length - 1;
  return [(1 - i1 / n) * S, (1 - i0 / n) * S];
}

function paintWheel(ctx: CanvasRenderingContext2D): void {
  const S = 512;
  const rng = mulberry32(7);
  const band = (i0: number, i1: number, fill: string): [number, number] => {
    const [y0, y1] = wheelBandY(i0, i1, S);
    ctx.fillStyle = fill;
    ctx.fillRect(0, y0, S, y1 - y0);
    return [y0, y1];
  };
  band(0, 1, '#1e2024'); // inboard rim
  band(1, 2, '#0f1013'); // inboard sidewall
  band(2, 3, '#121316'); // inboard shoulder
  const [ty0, ty1] = band(3, 5, '#17181b'); // tread
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = 0; i < 260; i++) ctx.fillRect(rng() * S, ty0 + rng() * (ty1 - ty0), 1.5, 3 + rng() * 9);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 120; i++) ctx.fillRect(rng() * S, ty0 + rng() * (ty1 - ty0), 1, 4 + rng() * 6);

  // outboard sidewall: branding ring + compound color ring
  const [by0, by1] = band(5, 7, '#0f1013');
  const bMid = (by0 + by1) / 2;
  ctx.fillStyle = '#e8b400'; // medium-compound ring
  ctx.fillRect(0, by0 + (by1 - by0) * 0.12, S, 4);
  for (let i = 0; i < 4; i++) {
    text(ctx, 'TURBINE', S * (i + 0.5) / 4, bMid + 4, 30, '#d8dce2', 0, false);
  }
  // rim face: flat generated spoke pattern
  const [ry0, ry1] = band(7, 8, '#0b0c0e');
  const spokes = 10;
  for (let i = 0; i < spokes; i++) {
    const x = (i + 0.15) * (S / spokes);
    const grad = ctx.createLinearGradient(x, 0, x + S / spokes * 0.55, 0);
    grad.addColorStop(0, '#82878f');
    grad.addColorStop(0.5, '#4a4e55');
    grad.addColorStop(1, '#0b0c0e');
    ctx.fillStyle = grad;
    ctx.fillRect(x, ry0, S / spokes * 0.55, ry1 - ry0);
  }
  ctx.fillStyle = '#9aa0a8'; // rim lip highlight
  ctx.fillRect(0, ry0, S, 3);
  ctx.fillStyle = '#14151a'; // hub / wheel-nut rows (nut geometry maps here)
  ctx.fillRect(0, 0, S, 16);
}

function paintWheelORM(ctx: CanvasRenderingContext2D): void {
  const S = 256;
  const band = (i0: number, i1: number, g: number, b: number): void => {
    const [y0, y1] = wheelBandY(i0, i1, S);
    ctx.fillStyle = `rgb(0,${g},${b})`;
    ctx.fillRect(0, y0, S, y1 - y0);
  };
  band(0, 1, 110, 200); // inboard rim: metal
  band(1, 3, 205, 0);   // sidewalls: rubber
  band(3, 5, 160, 0);   // tread: slick sheen
  band(5, 7, 205, 0);
  band(7, 8, 80, 235);  // rim face: glossy metal
  ctx.fillStyle = 'rgb(0,120,235)';
  ctx.fillRect(0, 0, S, 8); // hub rows
}

function dataTexture(size: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const tex = makeCanvasTexture(size, size, paint);
  tex.colorSpace = THREE.NoColorSpace; // roughness/metalness are data, not color
  return tex;
}

// ------------------------------------------------------------- build

export function createCarModel(opts: { livery: LiveryId }): CarModelHandle {
  const p = PALETTES[opts.livery];
  const root = new THREE.Group();
  root.name = `CarModel:${opts.livery}`;
  root.rotation.order = 'YXZ'; // yaw about world Y, then roll about local Z

  // ---------------------------------------------------------- materials
  const liveryTex = makeCanvasTexture(ATLAS, ATLAS, paintLiveryAtlas(p));
  const liveryMat = new THREE.MeshStandardMaterial({
    map: liveryTex,
    roughnessMap: dataTexture(256, paintLiveryRough()),
    roughness: 1.0,
    metalness: 0.35,
    // no scene envmap: emissiveMap=map at low intensity keeps the paint punchy
    emissive: 0xffffff,
    emissiveMap: liveryTex,
    emissiveIntensity: 0.16,
  });
  // low metalness on purpose: there is no scene envmap, so high metalness
  // would collapse the halo/suspension to black
  const carbonMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.22,
  });
  const wheelMat = new THREE.MeshStandardMaterial({
    map: makeCanvasTexture(512, 512, paintWheel),
    roughnessMap: dataTexture(256, paintWheelORM),
    metalnessMap: dataTexture(256, paintWheelORM),
    roughness: 1.0,
    metalness: 1.0,
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0c,
    emissive: 0xff2014,
    emissiveIntensity: 0.25,
    roughness: 0.5,
    metalness: 0,
  });

  // ---------------------------------------------------------- livery group
  const L: THREE.BufferGeometry[] = [];
  const addL = (g: THREE.BufferGeometry, r: Rect, mirrorU = false): void => {
    L.push(remapUV(g, r, mirrorU));
  };

  // nose cone: elliptical tapered cylinder, tip low at (0, 0.30, 2.29)
  addL(xf(new THREE.CylinderGeometry(0.05, 0.135, 1.55, 22, 1), {
    s: [1.6, 1, 1], rx: Math.PI / 2 + 0.09, p: [0, 0.375, 1.52],
  }), R_NOSE);
  // vanity panel / front bulkhead
  addL(xf(new THREE.BoxGeometry(0.5, 0.32, 0.62), { p: [0, 0.42, 0.72] }), R_NOSE);
  // monocoque
  addL(xf(new THREE.BoxGeometry(0.66, 0.40, 1.6), { p: [0, 0.40, 0.05] }), R_BODY);
  // cockpit side walls (leave the opening clear for driver + halo)
  addL(xf(new THREE.BoxGeometry(0.16, 0.15, 0.9), { p: [0.25, 0.63, 0.18] }), R_BODY);
  addL(xf(new THREE.BoxGeometry(0.16, 0.15, 0.9), { p: [-0.25, 0.63, 0.18] }), R_BODY);
  // front cowl ahead of the opening
  addL(xf(new THREE.BoxGeometry(0.52, 0.13, 0.4), { p: [0, 0.615, 0.76] }), R_BODY);
  // sidepods: squashed capsules, undercut carved by dark panels below (carbon).
  // mirrorU brings the readable side of the wrapped livery text outboard.
  for (const sx of [1, -1] as const) {
    addL(xf(new THREE.CapsuleGeometry(0.27, 1.0, 6, 16), {
      s: [1.25, 0.68, 1], rx: Math.PI / 2, p: [0.50 * sx, 0.40, -0.40],
    }), R_BODY, true);
  }
  // engine cover: long tapered capsule + gearbox spine
  addL(xf(new THREE.CapsuleGeometry(0.20, 1.5, 6, 16), {
    s: [0.75, 1.05, 1], rx: Math.PI / 2, p: [0, 0.60, -0.75],
  }), R_BODY, true);
  addL(xf(new THREE.BoxGeometry(0.16, 0.30, 0.9), { p: [0, 0.36, -1.92] }), R_BODY);
  // shark fin: sides carry the number plate. Flip u on the -x face so the
  // number reads left-to-right from BOTH sides (Three mirrors +x vs -x u).
  L.push(xf(boxFaceUV(new THREE.BoxGeometry(0.024, 0.30, 1.0),
    [R_NUMBER, R_NUMBER, R_BODY, R_BODY, R_BODY, R_BODY],
    [false, true, false, false, false, false]), { p: [0, 0.78, -1.35] }));
  // airbox / roll hoop — kept low + rearward so the onboard T-cam sees the
  // helmet over it instead of a dome filling the frame
  addL(xf(new THREE.CylinderGeometry(0.13, 0.18, 0.40, 14), {
    rx: -0.12, p: [0, 0.75, -0.24],
  }), R_BODY);
  // T-cam pod (broadcast yellow on rival, black on player)
  addL(xf(new THREE.BoxGeometry(0.28, 0.07, 0.11), { p: [0, 0.955, -0.22] }), R_POD);
  // helmet under the halo
  addL(xf(new THREE.SphereGeometry(0.132, 20, 14), { p: [0, 0.64, 0.18] }), R_HELMET);

  // front wing: 3 stacked elements + endplates + nose pylons
  addL(xf(new THREE.BoxGeometry(1.86, 0.028, 0.34), { p: [0, 0.10, 2.40] }), R_WING);
  addL(xf(new THREE.BoxGeometry(1.78, 0.022, 0.26), { rx: -0.22, p: [0, 0.165, 2.30] }), R_WING);
  addL(xf(new THREE.BoxGeometry(1.66, 0.020, 0.20), { rx: -0.38, p: [0, 0.235, 2.21] }), R_WING);
  addL(xf(new THREE.BoxGeometry(0.022, 0.24, 0.52), { ry: -0.12, p: [0.925, 0.19, 2.34] }), R_WING);
  addL(xf(new THREE.BoxGeometry(0.022, 0.24, 0.52), { ry: 0.12, p: [-0.925, 0.19, 2.34] }), R_WING);
  addL(xf(new THREE.BoxGeometry(0.05, 0.16, 0.28), { p: [0.09, 0.18, 2.15] }), R_WING);
  addL(xf(new THREE.BoxGeometry(0.05, 0.16, 0.28), { p: [-0.09, 0.18, 2.15] }), R_WING);

  // rear wing: narrow 2026 planes on a swan-neck pylon + beam wing
  addL(xf(new THREE.BoxGeometry(0.96, 0.032, 0.36), { rx: 0.34, p: [0, 0.90, -2.34] }), R_WING);
  addL(xf(new THREE.BoxGeometry(0.96, 0.024, 0.26), { rx: 0.55, p: [0, 1.00, -2.46] }), R_WING);
  L.push(xf(boxFaceUV(new THREE.BoxGeometry(0.024, 0.40, 0.55),
    [R_NUMBER, R_NUMBER, R_WING, R_WING, R_WING, R_WING],
    [false, true, false, false, false, false]), { p: [0.485, 0.90, -2.36] }));
  L.push(xf(boxFaceUV(new THREE.BoxGeometry(0.024, 0.40, 0.55),
    [R_NUMBER, R_NUMBER, R_WING, R_WING, R_WING, R_WING],
    [false, true, false, false, false, false]), { p: [-0.485, 0.90, -2.36] }));
  addL(xf(new THREE.BoxGeometry(0.045, 0.42, 0.20), { rx: 0.25, p: [0, 0.72, -2.12] }), R_BODY);
  addL(xf(new THREE.BoxGeometry(0.82, 0.022, 0.16), { rx: 0.50, p: [0, 0.48, -2.42] }), R_WING);
  addL(xf(new THREE.BoxGeometry(0.82, 0.022, 0.16), { rx: 0.65, p: [0, 0.56, -2.36] }), R_WING);

  const liveryGeo = mergeGeometries(L, false);
  const liveryMesh = new THREE.Mesh(liveryGeo, liveryMat);
  liveryMesh.castShadow = true;
  root.add(liveryMesh);

  // ---------------------------------------------------------- carbon group
  const CARBON = '#17181c';
  const DUCT = '#0d0e10';
  const TITANIUM = '#c2c7ce';
  const SUSP = '#232529';
  const C: THREE.BufferGeometry[] = [];
  const addC = (g: THREE.BufferGeometry, hex: string): void => {
    C.push(tint(g, hex));
  };

  // floor + plank + edge wings + tea tray
  addC(xf(new THREE.BoxGeometry(1.5, 0.05, 3.4), { p: [0, 0.055, -0.05] }), CARBON);
  addC(xf(new THREE.BoxGeometry(0.42, 0.028, 2.8), { p: [0, 0.02, 0.1] }), '#0e0f12');
  addC(xf(new THREE.BoxGeometry(0.14, 0.016, 1.3), { rz: 0.25, p: [0.80, 0.10, -0.35] }), CARBON);
  addC(xf(new THREE.BoxGeometry(0.14, 0.016, 1.3), { rz: -0.25, p: [-0.80, 0.10, -0.35] }), CARBON);
  addC(xf(new THREE.BoxGeometry(0.5, 0.05, 0.6), { p: [0, 0.06, 1.15] }), CARBON);
  // diffuser + strakes (rear tip rises)
  addC(xf(new THREE.BoxGeometry(1.0, 0.03, 0.8), { rx: 0.35, p: [0, 0.17, -1.95] }), '#101114');
  for (const sx of [-0.3, 0, 0.3]) {
    addC(xf(new THREE.BoxGeometry(0.016, 0.12, 0.5), { rx: 0.35, p: [sx, 0.20, -2.0] }), '#101114');
  }
  // sidepod undercuts + inlets (dark panels sell the 2026 clean-undercut look)
  for (const sx of [1, -1] as const) {
    addC(xf(new THREE.BoxGeometry(0.30, 0.02, 1.15), { rz: 0.55 * sx, p: [0.36 * sx, 0.24, -0.38] }), '#0a0b0d');
    addC(xf(new THREE.BoxGeometry(0.30, 0.15, 0.05), { p: [0.52 * sx, 0.47, 0.36] }), DUCT);
  }
  // airbox intake mouth
  addC(xf(new THREE.BoxGeometry(0.18, 0.11, 0.05), { p: [0, 0.88, 0.10] }), DUCT);
  // rear crash structure (carries the rain light)
  addC(xf(new THREE.BoxGeometry(0.14, 0.12, 0.55), { p: [0, 0.36, -2.25] }), CARBON);

  // halo: matte-titanium torus arc + front strut + rear legs
  {
    const haloGeo = new THREE.TorusGeometry(0.30, 0.035, 10, 28);
    haloGeo.scale(1, 1.25, 1); // elongate fore-aft (pre-rotation Y -> Z)
    haloGeo.rotateX(Math.PI / 2);
    haloGeo.translate(0, 0.80, 0.16);
    addC(haloGeo, TITANIUM);
    addC(rod(0, 0.55, 0.60, 0, 0.79, 0.53, 0.028), TITANIUM);
    addC(rod(0.26, 0.62, -0.15, 0.285, 0.79, -0.02, 0.030), TITANIUM);
    addC(rod(-0.26, 0.62, -0.15, -0.285, 0.79, -0.02, 0.030), TITANIUM);
  }

  // cockpit interior + headrest + driver (HANS, gloved hands, wheel)
  addC(xf(new THREE.BoxGeometry(0.46, 0.03, 0.85), { p: [0, 0.585, 0.22] }), '#0a0b0d');
  addC(xf(new THREE.BoxGeometry(0.40, 0.14, 0.22), { p: [0, 0.63, -0.10] }), '#101014');
  addC(xf(new THREE.BoxGeometry(0.40, 0.10, 0.28), { p: [0, 0.56, 0.06] }), '#1a1c20');
  addC(xf(new THREE.SphereGeometry(0.045, 10, 8), { p: [0.12, 0.575, 0.47] }), p.glove);
  addC(xf(new THREE.SphereGeometry(0.045, 10, 8), { p: [-0.12, 0.575, 0.47] }), p.glove);
  addC(xf(new THREE.BoxGeometry(0.27, 0.14, 0.05), { rx: -0.35, p: [0, 0.575, 0.50] }), '#101114');

  // mirrors: small carbon housings on stalks (a bright accent box here reads
  // as a floating brick from the onboard camera)
  addC(xf(new THREE.BoxGeometry(0.13, 0.07, 0.05), { p: [0.42, 0.60, 0.60] }), '#1f2126');
  addC(xf(new THREE.BoxGeometry(0.13, 0.07, 0.05), { p: [-0.42, 0.60, 0.60] }), '#1f2126');
  addC(rod(0.31, 0.55, 0.58, 0.40, 0.59, 0.60, 0.012), CARBON);
  addC(rod(-0.31, 0.55, 0.58, -0.40, 0.59, 0.60, 0.012), CARBON);

  // suspension: wishbones + pushrods (front) / + driveshafts (rear)
  for (const sx of [1, -1] as const) {
    // front
    addC(rod(sx * 0.30, 0.52, 1.90, sx * 0.64, 0.47, 1.74, 0.014), SUSP);
    addC(rod(sx * 0.30, 0.52, 1.45, sx * 0.64, 0.47, 1.68, 0.014), SUSP);
    addC(rod(sx * 0.30, 0.24, 1.92, sx * 0.66, 0.22, 1.72, 0.014), SUSP);
    addC(rod(sx * 0.30, 0.24, 1.48, sx * 0.66, 0.22, 1.70, 0.014), SUSP);
    addC(rod(sx * 0.62, 0.26, 1.70, sx * 0.32, 0.50, 1.62, 0.013), SUSP);
    // rear
    addC(rod(sx * 0.22, 0.50, -1.50, sx * 0.62, 0.46, -1.68, 0.014), SUSP);
    addC(rod(sx * 0.22, 0.50, -1.88, sx * 0.62, 0.46, -1.72, 0.014), SUSP);
    addC(rod(sx * 0.22, 0.22, -1.50, sx * 0.64, 0.20, -1.70, 0.014), SUSP);
    addC(rod(sx * 0.22, 0.22, -1.90, sx * 0.64, 0.20, -1.72, 0.014), SUSP);
    addC(rod(sx * 0.20, 0.36, -1.70, sx * 0.62, 0.36, -1.70, 0.026), '#2c2e33');
    // brake-duct scoops
    addC(xf(new THREE.BoxGeometry(0.10, 0.24, 0.30), { p: [sx * 0.585, 0.36, 1.70] }), DUCT);
    addC(xf(new THREE.BoxGeometry(0.10, 0.24, 0.30), { p: [sx * 0.585, 0.36, -1.70] }), DUCT);
  }

  const carbonGeo = mergeGeometries(C, false);
  const carbonMesh = new THREE.Mesh(carbonGeo, carbonMat);
  carbonMesh.castShadow = true;
  root.add(carbonMesh);

  // ---------------------------------------------------------- glow group
  const glowGeo = mergeGeometries([
    xf(new THREE.BoxGeometry(0.055, 0.16, 0.04), { p: [0, 0.34, -2.54] }), // FIA rain light
    xf(new THREE.BoxGeometry(0.86, 0.018, 0.024), { rx: 0.35, p: [0, 0.305, -2.32] }), // diffuser strip
  ], false);
  const glowMesh = new THREE.Mesh(glowGeo, glowMat);
  root.add(glowMesh);

  // ---------------------------------------------------------- wheels
  const lathe = new THREE.LatheGeometry(
    WHEEL_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)),
    30,
  );
  const nut = remapUV(new THREE.CylinderGeometry(0.055, 0.055, 0.26, 10), [0.3, 0.965, 0.7, 0.995]);
  const wheelGeo = mergeGeometries([lathe, nut], false);
  wheelGeo.rotateZ(-Math.PI / 2); // axis +Y -> +X, spoke face outboard at +X
  const wheels = new THREE.InstancedMesh(wheelGeo, wheelMat, 4);
  wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wheels.castShadow = true;
  root.add(wheels);

  // FL, FR, RL, RR — right side yawed 180° so spokes face outboard
  const WHEEL_POS = [
    new THREE.Vector3(WHEEL_X, TIRE_R, AXLE),
    new THREE.Vector3(-WHEEL_X, TIRE_R, AXLE),
    new THREE.Vector3(WHEEL_X, TIRE_R, -AXLE),
    new THREE.Vector3(-WHEEL_X, TIRE_R, -AXLE),
  ];
  let spin = 0;
  let steer = 0;
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _one = new THREE.Vector3(1, 1, 1);
  const updateWheels = (): void => {
    for (let i = 0; i < 4; i++) {
      const right = WHEEL_POS[i].x < 0;
      const yaw = (i < 2 ? steer : 0) + (right ? Math.PI : 0);
      _e.set(right ? -spin : spin, yaw, 0);
      _q.setFromEuler(_e);
      _m.compose(WHEEL_POS[i], _q, _one);
      wheels.setMatrixAt(i, _m);
    }
    wheels.instanceMatrix.needsUpdate = true;
  };
  updateWheels();
  wheels.computeBoundingSphere();

  // ---------------------------------------------------------- stats
  const triCount = (g: THREE.BufferGeometry): number =>
    (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  const triangleCount = Math.round(
    triCount(liveryGeo) + triCount(carbonGeo) + triCount(glowGeo) + 4 * triCount(wheelGeo),
  );

  let boost = false;

  return {
    root,
    triangleCount,
    setPose(position: THREE.Vector3, forward: THREE.Vector3, roll: number): void {
      root.position.copy(position);
      root.rotation.y = Math.atan2(forward.x, forward.z);
      root.rotation.z = roll;
      // restrained emissive pulse while deploying; rain light idles dim
      const t = performance.now() * 0.001;
      glowMat.emissiveIntensity = boost ? 1.5 + 0.55 * Math.sin(t * 9) : 0.25;
    },
    spinWheels(distance: number): void {
      spin += distance / TIRE_R; // forward roll = +rotation about local +X
      updateWheels();
    },
    setSteer(angle: number): void {
      steer = THREE.MathUtils.clamp(angle, -MAX_STEER, MAX_STEER);
      // wheel matrices refresh on the next spinWheels call each frame anyway,
      // but update now so a steer-only change is never a frame late
      updateWheels();
    },
    setBoostGlow(active: boolean): void {
      boost = active;
    },
  };
}
