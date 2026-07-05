/**
 * Track meshes built from TrackData (world mapping per scene.ts: sim (x, y)
 * -> (x, 0, -y)):
 *
 *  - asphalt ribbon: indexed strip, left/right edge verts at centerline
 *    ± width·normal, vertex-color patchiness + generated noise texture with a
 *    rubbered-in darker center band; UVs u across / v along s.
 *  - kerbs: raised cambered ribbons on BOTH edges wherever |kappa| exceeds a
 *    threshold, red/white s-banded stripe texture.
 *  - painted details (tiny y offsets, no z-fighting): white edge lines full
 *    lap, checkered start/finish band + grid slots, yellow Override detection
 *    line, green activation line.
 *  - deploy-zone tint overlays: one very subtle ribbon per TrackZone with a
 *    per-zone hue; setZoneTint(zoneId, color, opacity) lets the UI phase
 *    drive them.
 *  - grass ground plane + gravel run-off ribbons at Village / Copse / Stowe /
 *    Club corner outsides.
 *
 * All textures are generated canvases — strict local-only, no assets.
 */
import * as THREE from 'three';
import type { TrackData, TrackSample } from '../sim/types';
import { trackAt } from '../sim/track';
import { makeCanvasTexture, mulberry32, paintNoise, smoothNoiseField } from './utils';

// vertical stacking (m) — everything separated to avoid z-fighting
const Y_GRASS = -0.02;
const Y_GRAVEL = -0.008;
const Y_ASPHALT = 0;
const Y_ZONE_TINT = 0.006;
const Y_LINES = 0.012;
const Y_BANDS = 0.016;
const KERB_Y_IN = 0.026;
const KERB_Y_OUT = 0.008;

/** kerbs appear where |kappa| > 1/180 m (dilated ±16 m, runs >= 20 m) */
const KERB_KAPPA = 1 / 180;
const KERB_DILATE = 8;
const KERB_MIN_RUN = 10;

const WHITE: readonly [number, number, number] = [1, 1, 1];

interface StripSpec {
  /** inclusive sample-index range; i1 may exceed sample count to wrap */
  i0: number;
  i1: number;
  offA(smp: TrackSample): number;
  offB(smp: TrackSample): number;
  yA: number;
  yB: number;
  /** v texture coordinate = s * vScale (default 1 = meters) */
  vScale?: number;
  color?(sUnwrapped: number, across: 0 | 1, smp: TrackSample): readonly [number, number, number];
}

/** Accumulates ribbon strips into one indexed BufferGeometry. */
class MeshAccum {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private uvs: number[] = [];
  private indices: number[] = [];

  addStrip(track: TrackData, spec: StripSpec): void {
    const { samples, ds } = track;
    const count = samples.length;
    const base = this.positions.length / 3;
    let row = 0;
    for (let i = spec.i0; i <= spec.i1; i++, row++) {
      const smp = samples[((i % count) + count) % count];
      const s = i * ds;
      this.pushPair(
        smp, spec.offA(smp), spec.offB(smp), spec.yA, spec.yB,
        s * (spec.vScale ?? 1),
        spec.color ? spec.color(s, 0, smp) : WHITE,
        spec.color ? spec.color(s, 1, smp) : WHITE,
      );
      if (row > 0) this.pushQuad(base + (row - 1) * 2);
    }
  }

  /** Cross-track band between arbitrary s values (finer than sample spacing). */
  addBand(
    track: TrackData,
    sA: number,
    sB: number,
    offA: (p: { wLeft: number; wRight: number }) => number,
    offB: (p: { wLeft: number; wRight: number }) => number,
    y: number,
  ): void {
    const base = this.positions.length / 3;
    for (let r = 0; r <= 1; r++) {
      const s = r === 0 ? sA : sB;
      const p = trackAt(track, s);
      const smp: TrackSample = { s, ...p };
      this.pushPair(smp, offA(p), offB(p), y, y, r, WHITE, WHITE);
    }
    this.pushQuad(base);
  }

  private pushPair(
    smp: TrackSample,
    a: number,
    b: number,
    yA: number,
    yB: number,
    v: number,
    colA: readonly [number, number, number],
    colB: readonly [number, number, number],
  ): void {
    this.positions.push(
      smp.x + a * smp.nx, yA, -(smp.y + a * smp.ny),
      smp.x + b * smp.nx, yB, -(smp.y + b * smp.ny),
    );
    this.normals.push(0, 1, 0, 0, 1, 0);
    this.colors.push(colA[0], colA[1], colA[2], colB[0], colB[1], colB[2]);
    this.uvs.push(0, v, 1, v);
  }

  private pushQuad(p: number): void {
    this.indices.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setIndex(this.indices);
    return geo;
  }
}

export interface TrackMeshes {
  group: THREE.Group;
  /** UI hook: tint one deploy zone's overlay ribbon. Opacity ~0 hides it. */
  setZoneTint(zoneId: number, color: THREE.ColorRepresentation, opacity: number): void;
}

export function buildTrackMeshes(track: TrackData): TrackMeshes {
  const group = new THREE.Group();
  group.name = 'track';
  const count = track.samples.length;
  const rng = mulberry32(1337);

  // ---------------------------------------------------------------- asphalt
  // Asphalt map doubles as roughnessMap: the rubbered-in racing line is both
  // darker AND glossier (lower roughness where texels are darker), which is
  // what sells the surface on TV. Near-white texels only MODULATE the
  // material color (a mid-grey map on a mid-grey color multiplies to black).
  const asphaltTex = makeCanvasTexture(512, 1024, (ctx, w, h) => {
    const streak = smoothNoiseField(w, h, 20, 5, rng);   // elongated along s
    const patch = smoothNoiseField(w, h, 5, 9, rng);     // broad patchiness
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x01 = x / (w - 1);
        // gaussian rubber band on the driven line (center of ribbon)
        const g = Math.exp(-((x01 - 0.5) * (x01 - 0.5)) / (2 * 0.15 * 0.15));
        let v = 226 * (1 - 0.26 * g);
        // dusty/dirty extreme edges
        const e = Math.min(x01, 1 - x01);
        if (e < 0.05) v *= 0.92 + 1.6 * e;
        const i = (y * w + x) * 4;
        v += (streak[y * w + x] - 0.5) * 22 + (patch[y * w + x] - 0.5) * 14 + (rng() - 0.5) * 24;
        const c = Math.max(0, Math.min(255, v));
        d[i] = c;
        d[i + 1] = c;
        d[i + 2] = c + 3;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  asphaltTex.anisotropy = 16;
  asphaltTex.repeat.set(1, 1 / 14); // one tile across, repeat every 14 m along
  const rowTint: number[] = [];
  for (let i = 0; i <= count; i++) rowTint.push(0.93 + 0.1 * rng());
  const asphalt = new MeshAccum();
  asphalt.addStrip(track, {
    i0: 0,
    i1: count,
    offA: (p) => p.wLeft,
    offB: (p) => -p.wRight,
    yA: Y_ASPHALT,
    yB: Y_ASPHALT,
    color: (s) => {
      const t = rowTint[Math.round(s / track.ds) % (count + 1)];
      return [t, t, t];
    },
  });
  const asphaltMesh = new THREE.Mesh(
    asphalt.build(),
    new THREE.MeshStandardMaterial({
      color: 0x54585c,
      roughness: 1.0, // effective roughness comes from the map texels (~0.75-0.9)
      roughnessMap: asphaltTex,
      metalness: 0.02,
      map: asphaltTex,
      vertexColors: true,
      side: THREE.DoubleSide,
    }),
  );
  asphaltMesh.receiveShadow = true;
  group.add(asphaltMesh);

  // ---------------------------------------------------------------- kerbs
  // worn painted kerb: red/white banding with paint chips, grey scuffs and
  // faint rubber streaks running along the kerb (the v axis)
  const kerbTex = makeCanvasTexture(64, 256, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const scuffCols: number[] = [];
    for (let i = 0; i < 10; i++) scuffCols.push(Math.floor(rng() * w));
    for (let y = 0; y < h; y++) {
      const red = y < h / 2;
      for (let x = 0; x < w; x++) {
        let r = red ? 190 : 233;
        let g = red ? 34 : 231;
        let b = red ? 38 : 226;
        const n = (rng() - 0.5) * 26;
        r += n; g += n; b += n;
        // paint chips / grime
        if (rng() < 0.06) {
          const grey = 120 + rng() * 70;
          r = grey; g = grey; b = grey;
        }
        // rubber scuff streaks along v
        for (const sc of scuffCols) {
          if (Math.abs(x - sc) < 1.5) { r *= 0.82; g *= 0.82; b *= 0.82; }
        }
        const i = (y * w + x) * 4;
        d[i] = Math.max(0, Math.min(255, r));
        d[i + 1] = Math.max(0, Math.min(255, g));
        d[i + 2] = Math.max(0, Math.min(255, b));
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  const kerbFlags = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (Math.abs(track.samples[i].kappa) > KERB_KAPPA) {
      for (let o = -KERB_DILATE; o <= KERB_DILATE; o++) kerbFlags[(i + o + count) % count] = 1;
    }
  }
  const kerbs = new MeshAccum();
  let runStart = -1;
  // start scanning from a guaranteed-false index (a straight) to keep runs simple
  let scan0 = 0;
  while (kerbFlags[scan0] && scan0 < count) scan0++;
  for (let k = scan0; k <= scan0 + count; k++) {
    const on = k < scan0 + count && kerbFlags[k % count] === 1;
    if (on && runStart < 0) runStart = k;
    if (!on && runStart >= 0) {
      if (k - runStart >= KERB_MIN_RUN) {
        // offA must be the MORE-LEFT (larger) offset: winding determines the
        // face the up-normal is attached to (DoubleSide flips it on backfaces)
        kerbs.addStrip(track, {
          i0: runStart, i1: k - 1, vScale: 1 / 4.5,
          offA: (p) => p.wLeft + 1.0, offB: (p) => p.wLeft - 0.1,
          yA: KERB_Y_OUT, yB: KERB_Y_IN,
        });
        kerbs.addStrip(track, {
          i0: runStart, i1: k - 1, vScale: 1 / 4.5,
          offA: (p) => -(p.wRight - 0.1), offB: (p) => -(p.wRight + 1.0),
          yA: KERB_Y_IN, yB: KERB_Y_OUT,
        });
      }
      runStart = -1;
    }
  }
  kerbTex.anisotropy = 16;
  const kerbMesh = new THREE.Mesh(
    kerbs.build(),
    new THREE.MeshStandardMaterial({
      map: kerbTex,
      roughness: 0.55, // painted concrete keeps a slight gloss
      metalness: 0,
      side: THREE.DoubleSide,
    }),
  );
  kerbMesh.receiveShadow = true;
  group.add(kerbMesh);

  // ---------------------------------------------------------------- painted lines
  const lines = new MeshAccum();
  // white edge lines, full lap, both sides
  lines.addStrip(track, {
    i0: 0, i1: count,
    offA: (p) => p.wLeft - 0.12, offB: (p) => p.wLeft - 0.42,
    yA: Y_LINES, yB: Y_LINES,
  });
  lines.addStrip(track, {
    i0: 0, i1: count,
    offA: (p) => -(p.wRight - 0.42), offB: (p) => -(p.wRight - 0.12),
    yA: Y_LINES, yB: Y_LINES,
  });
  // grid slot markers down the pit straight (staggered)
  for (let g = 0; g < 6; g++) {
    const sSlot = 10 + g * 8;
    const off = g % 2 === 0 ? 3.0 : -3.0;
    lines.addBand(track, sSlot, sSlot + 0.45, () => off + 1.4, () => off - 1.4, Y_LINES);
  }
  const lineMesh = new THREE.Mesh(
    lines.build(),
    new THREE.MeshStandardMaterial({
      color: 0xf2f2ee,
      roughness: 0.55,
      metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  lineMesh.receiveShadow = true;
  group.add(lineMesh);

  // checkered start/finish band at s = 0
  const checkerTex = makeCanvasTexture(512, 128, (ctx, w, h) => {
    const cols = 16;
    const rows = 4;
    const cw = w / cols;
    const chh = h / rows;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        ctx.fillStyle = (cx + cy) % 2 === 0 ? '#111114' : '#efefec';
        ctx.fillRect(cx * cw, cy * chh, cw, chh);
      }
    }
  });
  const checker = new MeshAccum();
  checker.addBand(track, 0, 2.4, (p) => p.wLeft - 0.15, (p) => -(p.wRight - 0.15), Y_BANDS);
  const checkerMesh = new THREE.Mesh(
    checker.build(),
    new THREE.MeshStandardMaterial({ map: checkerTex, roughness: 0.6, side: THREE.DoubleSide }),
  );
  group.add(checkerMesh);

  // Manual Override detection (yellow) + activation (green) lines
  const bandMesh = (sMid: number, color: number): THREE.Mesh => {
    const acc = new MeshAccum();
    acc.addBand(track, sMid - 0.5, sMid + 0.5, (p) => p.wLeft - 0.15, (p) => -(p.wRight - 0.15), Y_BANDS);
    const mesh = new THREE.Mesh(
      acc.build(),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.55,
        emissive: color,
        emissiveIntensity: 0.18,
        side: THREE.DoubleSide,
      }),
    );
    group.add(mesh);
    return mesh;
  };
  bandMesh(track.detectionLineS, 0xf3c614);
  bandMesh(track.activationLineS, 0x2ec24e);

  // ---------------------------------------------------------------- deploy-zone tints
  const zoneMats = new Map<number, THREE.MeshBasicMaterial>();
  const zoneMeshes = new Map<number, THREE.Mesh>();
  for (const zone of track.zones) {
    const acc = new MeshAccum();
    acc.addStrip(track, {
      i0: Math.round(zone.sStart / track.ds),
      i1: Math.round(zone.sEnd / track.ds),
      offA: (p) => p.wLeft - 0.55,
      offB: (p) => -(p.wRight - 0.55),
      yA: Y_ZONE_TINT,
      yB: Y_ZONE_TINT,
    });
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL((zone.id * 0.618034) % 1, 0.7, 0.55),
      transparent: true,
      opacity: 0.045,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(acc.build(), mat);
    mesh.renderOrder = 1;
    zoneMats.set(zone.id, mat);
    zoneMeshes.set(zone.id, mesh);
    group.add(mesh);
  }

  // ---------------------------------------------------------------- grass + gravel
  const bbox = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const smp of track.samples) bbox.expandByPoint(v.set(smp.x, 0, -smp.y));
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const groundSize = Math.max(size.x, size.z) + 1800;

  // mowed-airfield grass: alternating mow stripes (like the real Silverstone
  // TV shots), broad yellow-green patchiness, fine blade noise. The tile is
  // 36 m so each of the 4 stripes is ~9 m wide.
  const grassTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    const patch = smoothNoiseField(w, h, 5, 5, rng);
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const stripe = 1 + 0.06 * Math.tanh(Math.sin((x / w) * Math.PI * 2 * 4) * 3);
        const p = patch[y * w + x] - 0.5;
        const grain = (rng() - 0.5) * 20;
        const i = (y * w + x) * 4;
        // yellow-green patches: warm r/g shift where the patch field is high
        d[i] = Math.max(0, Math.min(255, (218 + p * 34) * stripe + grain));
        d[i + 1] = Math.max(0, Math.min(255, (228 + p * 16) * stripe + grain));
        d[i + 2] = Math.max(0, Math.min(255, (204 - p * 18) * stripe + grain));
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  grassTex.anisotropy = 8;
  grassTex.repeat.set(groundSize / 36, groundSize / 36);
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({ color: 0x7a9e50, map: grassTex, roughness: 1 }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(center.x, Y_GRASS, center.z);
  grass.receiveShadow = true;
  group.add(grass);

  // gravel run-offs at the big corner outsides (all right-handers -> left side)
  const gravelTex = makeCanvasTexture(128, 128, (ctx, w, h) => {
    paintNoise(ctx, w, h, [232, 226, 212], 22, rng);
    // scattered larger stones
    for (let i = 0; i < 240; i++) {
      const shade = 150 + rng() * 105;
      ctx.fillStyle = `rgb(${shade},${shade * 0.97},${shade * 0.9})`;
      ctx.fillRect(Math.floor(rng() * w), Math.floor(rng() * h), 2, 2);
    }
  });
  gravelTex.repeat.set(3, 1);
  const RUNOFFS: Array<{ s0: number; s1: number; extent: number }> = [
    { s0: 800, s1: 960, extent: 16 },   // Village
    { s0: 3010, s1: 3210, extent: 22 }, // Copse
    { s0: 4940, s1: 5180, extent: 26 }, // Stowe
    { s0: 5545, s1: 5790, extent: 18 }, // Club
  ];
  const gravel = new MeshAccum();
  for (const r of RUNOFFS) {
    const i0 = Math.round(r.s0 / track.ds);
    const i1 = Math.round(r.s1 / track.ds);
    const span = i1 - i0;
    gravel.addStrip(track, {
      i0, i1, vScale: 1 / 6,
      offA: (p) => {
        const t = (Math.round(p.s / track.ds) - i0) / span;
        const taper = Math.min(1, Math.min(t, 1 - t) * 4);
        const e = taper * taper * (3 - 2 * taper);
        return p.wLeft + 1.5 + r.extent * e;
      },
      offB: (p) => p.wLeft + 1.2,
      yA: Y_GRAVEL, yB: Y_GRAVEL,
    });
  }
  const gravelMesh = new THREE.Mesh(
    gravel.build(),
    new THREE.MeshStandardMaterial({ map: gravelTex, color: 0xcabb9d, roughness: 1, side: THREE.DoubleSide }),
  );
  gravelMesh.receiveShadow = true;
  group.add(gravelMesh);

  // ---------------------------------------------------------------- skid marks
  // tire-line pairs fading into the heavy braking zones (one merged mesh)
  const SKIDS: Array<{ s0: number; s1: number }> = [
    { s0: 700, s1: 850 },   // into Village
    { s0: 940, s1: 1015 },  // into The Loop
    { s0: 1800, s1: 1930 }, // into Brooklands
    { s0: 4890, s1: 4990 }, // into Stowe
    { s0: 5300, s1: 5470 }, // into Vale
  ];
  const skids = new MeshAccum();
  for (const sk of SKIDS) {
    const i0 = Math.round(sk.s0 / track.ds);
    const i1 = Math.round(sk.s1 / track.ds);
    const span = Math.max(1, i1 - i0);
    const width = (p: TrackSample): number => {
      const t = (Math.round(p.s / track.ds) - i0) / span;
      return 0.1 + 0.32 * Math.min(1, Math.max(0, t)); // widen toward the corner
    };
    for (const lane of [-0.82, 0.82]) {
      skids.addStrip(track, {
        i0, i1,
        offA: (p) => lane + width(p) / 2,
        offB: (p) => lane - width(p) / 2,
        yA: Y_ZONE_TINT + 0.002, yB: Y_ZONE_TINT + 0.002,
      });
    }
  }
  const skidMesh = new THREE.Mesh(
    skids.build(),
    new THREE.MeshBasicMaterial({
      color: 0x0c0d0f,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  skidMesh.renderOrder = 1;
  group.add(skidMesh);

  return {
    group,
    setZoneTint(zoneId: number, color: THREE.ColorRepresentation, opacity: number): void {
      const mat = zoneMats.get(zoneId);
      const mesh = zoneMeshes.get(zoneId);
      if (!mat || !mesh) return;
      mat.color.set(color);
      mat.opacity = opacity;
      mesh.visible = opacity > 0.002;
    },
  };
}
