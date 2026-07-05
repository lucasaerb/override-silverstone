/**
 * Small shared helpers for the render layer: deterministic RNG (stable
 * screenshots) and generated canvas textures (strict local-only, no external
 * assets anywhere in the renderer).
 */
import * as THREE from 'three';

/** Deterministic 32-bit PRNG so environment scatter / noise is stable per build. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Creates a repeating sRGB CanvasTexture painted by `paint`. */
export function makeCanvasTexture(
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  paint(ctx, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Tileable smooth value-noise field (bilinear-interpolated coarse grid with
 * wrap), values 0..1. Used for low-frequency patchiness in generated
 * textures — grass patches, asphalt streaking.
 */
export function smoothNoiseField(
  w: number,
  h: number,
  cellsX: number,
  cellsY: number,
  rng: () => number,
): Float32Array {
  const grid = new Float32Array(cellsX * cellsY);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = (y / h) * cellsY;
    const y0 = Math.floor(gy) % cellsY;
    const y1 = (y0 + 1) % cellsY;
    const fy = gy - Math.floor(gy);
    for (let x = 0; x < w; x++) {
      const gx = (x / w) * cellsX;
      const x0 = Math.floor(gx) % cellsX;
      const x1 = (x0 + 1) % cellsX;
      const fx = gx - Math.floor(gx);
      const a = grid[y0 * cellsX + x0];
      const b = grid[y0 * cellsX + x1];
      const c = grid[y1 * cellsX + x0];
      const d = grid[y1 * cellsX + x1];
      // smoothstep the lerp factors for softer patches
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      out[y * w + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    }
  }
  return out;
}

/**
 * Per-pixel RGB noise around a base color. `xProfile` optionally scales
 * brightness as a function of the horizontal position (0..1) — used to darken
 * the rubbered-in center of the asphalt ribbon.
 */
export function paintNoise(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  base: readonly [number, number, number],
  jitter: number,
  rng: () => number,
  xProfile?: (x01: number) => number,
): void {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = xProfile ? xProfile(x / (w - 1)) : 1;
      const n = (rng() - 0.5) * 2 * jitter;
      const i = (y * w + x) * 4;
      d[i] = Math.max(0, Math.min(255, base[0] * f + n));
      d[i + 1] = Math.max(0, Math.min(255, base[1] * f + n));
      d[i + 2] = Math.max(0, Math.min(255, base[2] * f + n));
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
