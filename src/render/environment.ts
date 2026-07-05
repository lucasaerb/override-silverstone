/**
 * Stylized-broadcast Silverstone surroundings (world mapping per scene.ts):
 *
 *  - InstancedMesh grandstands (stepped rows + roof slab, crowd-speckle
 *    canvas texture) along the pit straight and at Copse / Stowe / Club /
 *    Luffield outsides, placed via trackAt(s) + normal offsets.
 *  - The Wing pit building: long low white/silver segments with a roofline
 *    and dark glass band along the pit straight's right side, plus pit wall.
 *  - Instanced tree lines (cone + trunk) scattered around the perimeter with
 *    a deterministic RNG; rejected if within 26 m of any centerline sample.
 *  - Distant gradient-sky dome (inverted sphere, vertical gradient shader
 *    with a warm glow around the scene sun; screenshot-stable, no animation).
 *  - Marshal-post flags (instanced posts + colored flag planes) at corners.
 *
 * Everything is instanced or merged — the whole environment is ~12 draw calls.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TrackData } from '../sim/types';
import { trackAt } from '../sim/track';
import { simDirToWorld, simToWorld, SUN_DIRECTION } from './scene';
import { makeCanvasTexture, mulberry32, paintNoise } from './utils';

const UP = new THREE.Vector3(0, 1, 0);

/** yaw so that local +Z points along `dir` (XZ plane). */
function yawTo(dir: THREE.Vector3): number {
  return Math.atan2(dir.x, dir.z);
}

export function buildEnvironment(track: TrackData): THREE.Group {
  const group = new THREE.Group();
  group.name = 'environment';
  const rng = mulberry32(20260705);

  const bbox = new THREE.Box3();
  const tmp = new THREE.Vector3();
  for (const smp of track.samples) bbox.expandByPoint(tmp.set(smp.x, 0, -smp.y));
  const center = bbox.getCenter(new THREE.Vector3());

  // ---------------------------------------------------------------- sky dome
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false, // drawn first (renderOrder -100), everything covers it
    uniforms: { sunDir: { value: SUN_DIRECTION.clone() } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        // late-afternoon British summer: deep blue zenith grading through a
        // paler mid-sky to a warm hazy horizon (three-stop vertical gradient).
        vec3 zenith  = vec3(0.13, 0.31, 0.66);
        vec3 mid     = vec3(0.33, 0.51, 0.78);
        vec3 horizon = vec3(0.79, 0.82, 0.82);
        float t = pow(h, 0.52);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.5, t));
        col = mix(col, zenith, smoothstep(0.42, 1.0, t));
        // warm haze thickening toward the horizon line + gentle sun-side warmth
        float md = max(dot(d, sunDir), 0.0);
        col = mix(col, vec3(0.90, 0.85, 0.76), (1.0 - smoothstep(0.0, 0.20, h)) * (0.32 + 0.34 * md));
        // sun: broad glow, tight halo, soft disc near the sun direction
        float glow = pow(md, 5.0);
        float halo = pow(md, 90.0);
        float disc = smoothstep(0.9976, 0.9990, md);
        col += vec3(1.00, 0.66, 0.36) * glow * 0.22;
        col += vec3(1.00, 0.86, 0.62) * halo * 0.6;
        col = mix(col, vec3(1.00, 0.96, 0.88), disc);
        // fade to the haze colour right at / below the horizon so ground meets sky
        col = mix(col, horizon, smoothstep(0.02, -0.06, d.y));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(3500, 32, 16), skyMat);
  sky.position.set(center.x, 0, center.z);
  sky.frustumCulled = false;
  sky.renderOrder = -100;
  group.add(sky);

  // ---------------------------------------------------------------- grandstands
  // seated-crowd rows: horizontal seat-row structure, people as short colored
  // ticks on each row, slightly darker toward the (roofed) top rows
  const crowdTex = makeCanvasTexture(256, 64, (ctx, w, h) => {
    paintNoise(ctx, w, h, [108, 110, 118], 12, rng);
    ctx.fillStyle = 'rgba(40,42,48,0.55)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1); // seat-row lines
    const palette = ['#b53736', '#3a5db8', '#d9d9d2', '#c99920', '#3f9a58', '#734ba6', '#20242c', '#e0e0da'];
    for (let row = 0; row < h / 4; row++) {
      const shade = 0.7 + 0.3 * (row / (h / 4)); // top rows in roof shadow
      for (let i = 0; i < 42; i++) {
        const c = palette[Math.floor(rng() * palette.length)];
        ctx.globalAlpha = shade;
        ctx.fillStyle = c;
        ctx.fillRect(Math.floor(rng() * w), row * 4 + 1, 1, 2);
      }
    }
    ctx.globalAlpha = 1;
  });
  interface StandSpec { s: number; side: 1 | -1 }
  const STANDS: StandSpec[] = [
    // pit straight, spectator (left) side, opposite the Wing
    { s: 5865, side: 1 }, { s: 65, side: 1 }, { s: 150, side: 1 }, { s: 235, side: 1 }, { s: 320, side: 1 },
    { s: 3080, side: 1 }, { s: 3175, side: 1 },   // Copse outside
    // Stowe outside is the dedicated LANDOSTAND (built separately, below)
    { s: 5620, side: 1 }, { s: 5715, side: 1 },   // Club outside
    { s: 2120, side: 1 }, { s: 2215, side: 1 },   // Luffield outside
  ];
  const STEPS = 7;
  const stepGeo = new THREE.BoxGeometry(1, 1, 1);
  const stepMat = new THREE.MeshStandardMaterial({ map: crowdTex, roughness: 0.9 });
  const steps = new THREE.InstancedMesh(stepGeo, stepMat, STANDS.length * STEPS);
  const ROOF_Y = 7.6;
  const ROOF_H = 0.5;
  const roofGeo = new THREE.BoxGeometry(30, ROOF_H, 11.5);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8b939b, roughness: 0.4, metalness: 0.55 });
  const roofs = new THREE.InstancedMesh(roofGeo, roofMat, STANDS.length);
  // a thin fascia lip hanging off the roof's leading edge + support columns
  // rising from the ground to the roof underside, so the roof reads as
  // structurally held rather than floating over the crowd.
  const fasciaGeo = new THREE.BoxGeometry(30, 1.1, 0.3);
  const fasciaMat = new THREE.MeshStandardMaterial({ color: 0x6f767e, roughness: 0.5, metalness: 0.5 });
  const fascias = new THREE.InstancedMesh(fasciaGeo, fasciaMat, STANDS.length);
  const POST_XS = [-12.5, -4.2, 4.2, 12.5];
  const POST_UNDER = ROOF_Y - ROOF_H / 2; // 7.35 m to the roof underside
  const postGeo2 = new THREE.BoxGeometry(0.28, POST_UNDER, 0.28);
  postGeo2.translate(0, POST_UNDER / 2, 0); // base at ground when instance y=0
  const postMat2 = new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.55, metalness: 0.6 });
  const standPosts = new THREE.InstancedMesh(postGeo2, postMat2, STANDS.length * POST_XS.length);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const perp = new THREE.Vector3();
  let stepIdx = 0;
  let postIdx = 0;
  STANDS.forEach((spec, standIdx) => {
    const p = trackAt(track, spec.s);
    const w = spec.side > 0 ? p.wLeft : p.wRight;
    const basePos = simToWorld(p.x + spec.side * (w + 28) * p.nx, p.y + spec.side * (w + 28) * p.ny);
    const face = simDirToWorld(-spec.side * p.nx, -spec.side * p.ny).normalize();
    q.setFromAxisAngle(UP, yawTo(face));
    const back = face.clone().negate();
    perp.set(face.z, 0, -face.x); // stand-width axis (roof local +X in world)
    for (let k = 0; k < STEPS; k++) {
      pos.copy(basePos).addScaledVector(back, 1.55 * k).setY(0.45 + 0.82 * k);
      scl.set(28, 0.9, 1.7);
      m4.compose(pos, q, scl);
      steps.setMatrixAt(stepIdx++, m4);
    }
    pos.copy(basePos).addScaledVector(back, 4.6).setY(ROOF_Y);
    scl.set(1, 1, 1);
    m4.compose(pos, q, scl);
    roofs.setMatrixAt(standIdx, m4);
    // fascia lip at the roof's leading (track-facing) edge
    pos.copy(basePos).addScaledVector(face, 1.15).setY(ROOF_Y - 0.35);
    m4.compose(pos, q, scl);
    fascias.setMatrixAt(standIdx, m4);
    // support columns under the leading edge, spread across the width
    for (const xo of POST_XS) {
      pos.copy(basePos).addScaledVector(face, 1.05).addScaledVector(perp, xo).setY(0);
      m4.compose(pos, q, scl);
      standPosts.setMatrixAt(postIdx++, m4);
    }
  });
  steps.castShadow = true;
  steps.receiveShadow = true;
  steps.frustumCulled = false;
  roofs.castShadow = true;
  roofs.frustumCulled = false;
  fascias.frustumCulled = false;
  standPosts.castShadow = true;
  standPosts.frustumCulled = false;
  group.add(steps, roofs, fascias, standPosts);

  // ---------------------------------------------------------------- crowds
  // ALL spectators (every regular stand + the Landostand) share ONE
  // InstancedMesh of small colored blocks. Each block is a *seat cluster* of
  // several fans — never one detailed person — scattered across the seating
  // slopes with a per-instance team/flag colour, position/height jitter and a
  // little yaw so the mass reads as thousands of individuals from broadcast
  // range while costing a single draw call. The crowd-speckle step texture
  // underneath fills the gaps between blocks. Instances are collected here and
  // the mesh is built after the Landostand contributes its (papaya) rows.
  // broadcast crowd: mostly pale/neutral clothing with sparse bright team specks
  const CROWD_PALETTE = [
    '#c9c9c4', '#d8d8d2', '#b9bdc3', '#e2e2dc', '#a9adb4', '#cfd3d8', '#e0e0da',
    '#b0b4ba', '#c25b4e', '#3d63bf', '#e6c33a', '#3f9a58', '#7050a8', '#d98b3a',
    '#26303e', '#ffffff', '#9aa0a8', '#d7cbb6',
  ];
  // Landostand: fluorescent-yellow / papaya dominant with black + a little white
  const LANDO_PALETTE = [
    '#ffe600', '#ffe600', '#ffe600', '#ffd400', '#f7d200', '#ffb300',
    '#ff8a00', '#ff8a00', '#151510', '#151510', '#fff27a', '#ffffff',
  ];
  const crowdMats: THREE.Matrix4[] = [];
  const crowdCols: THREE.Color[] = [];
  const cMat = new THREE.Matrix4();
  const cQuat = new THREE.Quaternion();
  const cPos = new THREE.Vector3();
  const cScl = new THREE.Vector3();
  const cCol = new THREE.Color();
  const pickCol = (pal: string[]): string => pal[(rng() * pal.length) | 0];
  // scatter seat clusters across one stand's stepped seating slope
  const addCrowd = (
    base: THREE.Vector3, faceV: THREE.Vector3, backV: THREE.Vector3, perpV: THREE.Vector3,
    tiers: number, backStep: number, rise: number, baseY: number, halfWidth: number,
    palette: string[],
  ): void => {
    const yaw0 = yawTo(faceV);
    const cols = Math.max(4, Math.floor((2 * halfWidth) / 1.12));
    const colStep = (2 * halfWidth) / cols;
    for (let k = 0; k < tiers; k++) {
      // upper rows sit under the roof / deeper in shadow -> render them darker
      const shade = 0.64 + 0.36 * (1 - k / tiers);
      for (let c = 0; c < cols; c++) {
        const xo = -halfWidth + (c + 0.5) * colStep + (rng() - 0.5) * 0.5;
        cPos.copy(base)
          .addScaledVector(backV, backStep * k)
          .addScaledVector(faceV, 0.3 + (rng() - 0.5) * 0.4)
          .addScaledVector(perpV, xo);
        cPos.y = baseY + rise * k + (rng() - 0.5) * 0.12;
        cQuat.setFromAxisAngle(UP, yaw0 + (rng() - 0.5) * 0.55);
        const sc = 0.85 + rng() * 0.32;
        cScl.set(sc, 0.82 + rng() * 0.4, sc);
        cMat.compose(cPos, cQuat, cScl);
        crowdMats.push(cMat.clone());
        crowdCols.push(cCol.set(pickCol(palette)).multiplyScalar(shade).clone());
      }
    }
  };
  // regular stands: fill each seating slope with the neutral crowd palette
  STANDS.forEach((spec) => {
    const p = trackAt(track, spec.s);
    const w = spec.side > 0 ? p.wLeft : p.wRight;
    const base = simToWorld(p.x + spec.side * (w + 28) * p.nx, p.y + spec.side * (w + 28) * p.ny);
    const faceV = simDirToWorld(-spec.side * p.nx, -spec.side * p.ny).normalize();
    const backV = faceV.clone().negate();
    const perpV = new THREE.Vector3(faceV.z, 0, -faceV.x);
    addCrowd(base, faceV, backV, perpV, STEPS, 1.55, 0.82, 0.72, 13.4, CROWD_PALETTE);
  });

  // ---------------------------------------------------------------- LANDOSTAND (Stowe)
  // The 2026 Lando Norris 16,000-seat WRAP-AROUND stand on the outside of
  // Stowe (T15, a fast right-hander — outside is the LEFT / +nx side). Built
  // as ~14 tangentially-oriented modules stepped along ~155 m of arc so it
  // curves around the corner; taller (11 tiers, ~13 m roof) and deeper than a
  // regular stand, in fluorescent-yellow / black livery with a papaya crowd
  // and a repeating LANDOSTAND banner along the roof fascia.
  const landoCrowdTex = makeCanvasTexture(256, 64, (ctx, w, h) => {
    paintNoise(ctx, w, h, [150, 138, 40], 16, rng); // warm yellow base
    ctx.fillStyle = 'rgba(28,26,18,0.5)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1); // seat-row lines
    const pal = ['#ffe600', '#ffd400', '#ffb300', '#ff8a00', '#151510', '#fff27a', '#ffffff'];
    for (let row = 0; row < h / 4; row++) {
      const shade = 0.7 + 0.3 * (1 - row / (h / 4));
      for (let i = 0; i < 52; i++) {
        ctx.globalAlpha = shade;
        ctx.fillStyle = pal[(rng() * pal.length) | 0];
        ctx.fillRect(Math.floor(rng() * w), row * 4 + 1, 1, 2);
      }
    }
    ctx.globalAlpha = 1;
  });
  // roof-fascia banner: bold black LANDOSTAND on papaya-yellow with a black/
  // yellow checker trim; one whole word per module -> legible at mid distance
  const landoBannerTex = makeCanvasTexture(512, 96, (ctx, w, h) => {
    ctx.fillStyle = '#ffe600';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#151510';
    const cs = 12;
    for (let x = 0; x < w; x += cs * 2) {
      ctx.fillRect(x, 0, cs, cs);
      ctx.fillRect(x + cs, h - cs, cs, cs);
    }
    ctx.fillStyle = '#151510';
    ctx.font = '900 58px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('LANDOSTAND', w / 2, h / 2 + 3);
  });
  landoBannerTex.wrapS = THREE.ClampToEdgeWrapping;
  landoBannerTex.wrapT = THREE.ClampToEdgeWrapping;
  landoBannerTex.repeat.set(1, 1);

  const LSTEPS = 11;
  const LRISE = 1.0;
  const LDEPTH = 1.9;
  const LSEG_W = 15;
  const LSEG_STEP = 11.5;
  const LFRONT_OFF = 31;
  const LROOF_Y = LSTEPS * LRISE + 2.4; // ~13.4 m
  const LSEAT_DEPTH = LDEPTH * LSTEPS; // total slope depth ~21 m
  const landoS: number[] = [];
  for (let s = 5006; s <= 5162; s += LSEG_STEP) landoS.push(s);
  const NSEG = landoS.length;

  const landoStepGeo = new THREE.BoxGeometry(LSEG_W, 1.2, LDEPTH);
  const landoStepMat = new THREE.MeshStandardMaterial({ map: landoCrowdTex, roughness: 0.9 });
  const landoSteps = new THREE.InstancedMesh(landoStepGeo, landoStepMat, NSEG * LSTEPS);
  const landoRoofGeo = new THREE.BoxGeometry(LSEG_W + 1.2, 0.55, LSEAT_DEPTH + 1.5);
  const landoRoofMat = new THREE.MeshStandardMaterial({ color: 0xffe000, roughness: 0.42, metalness: 0.32 });
  const landoRoofs = new THREE.InstancedMesh(landoRoofGeo, landoRoofMat, NSEG);
  const landoBannerGeo = new THREE.BoxGeometry(LSEG_W, 2.6, 0.4);
  const landoBannerMat = new THREE.MeshStandardMaterial({ map: landoBannerTex, roughness: 0.55, metalness: 0.1 });
  const landoBanners = new THREE.InstancedMesh(landoBannerGeo, landoBannerMat, NSEG);
  const landoWallGeo = new THREE.BoxGeometry(LSEG_W + 1.2, LROOF_Y, 0.7);
  landoWallGeo.translate(0, LROOF_Y / 2, 0); // base at ground when instance y=0
  const landoWallMat = new THREE.MeshStandardMaterial({ color: 0x141410, roughness: 0.72, metalness: 0.2 });
  const landoWalls = new THREE.InstancedMesh(landoWallGeo, landoWallMat, NSEG);
  const LPOST_XS = [-6.2, 0, 6.2];
  const landoPostGeo = new THREE.BoxGeometry(0.34, LROOF_Y, 0.34);
  landoPostGeo.translate(0, LROOF_Y / 2, 0);
  const landoPostMat = new THREE.MeshStandardMaterial({ color: 0x18180f, roughness: 0.55, metalness: 0.45 });
  const landoPosts = new THREE.InstancedMesh(landoPostGeo, landoPostMat, NSEG * LPOST_XS.length);

  let lStep = 0;
  let lPost = 0;
  landoS.forEach((s, i) => {
    const p = trackAt(track, s);
    const w = p.wLeft; // outside of the Stowe right-hander = left (+n) side
    const base = simToWorld(p.x + (w + LFRONT_OFF) * p.nx, p.y + (w + LFRONT_OFF) * p.ny);
    const faceV = simDirToWorld(-p.nx, -p.ny).normalize(); // toward the track
    const backV = faceV.clone().negate();
    const perpV = new THREE.Vector3(faceV.z, 0, -faceV.x);
    q.setFromAxisAngle(UP, yawTo(faceV));
    scl.set(1, 1, 1);
    for (let k = 0; k < LSTEPS; k++) {
      pos.copy(base).addScaledVector(backV, LDEPTH * k).setY(0.6 + LRISE * k);
      m4.compose(pos, q, scl);
      landoSteps.setMatrixAt(lStep++, m4);
    }
    m4.compose(pos.copy(base).addScaledVector(backV, LSEAT_DEPTH * 0.5).setY(LROOF_Y), q, scl);
    landoRoofs.setMatrixAt(i, m4);
    m4.compose(pos.copy(base).addScaledVector(faceV, 0.5).setY(LROOF_Y - 1.7), q, scl);
    landoBanners.setMatrixAt(i, m4);
    m4.compose(pos.copy(base).addScaledVector(backV, LSEAT_DEPTH + 0.6).setY(0), q, scl);
    landoWalls.setMatrixAt(i, m4);
    for (const xo of LPOST_XS) {
      m4.compose(pos.copy(base).addScaledVector(faceV, 0.5).addScaledVector(perpV, xo).setY(0), q, scl);
      landoPosts.setMatrixAt(lPost++, m4);
    }
    addCrowd(base, faceV, backV, perpV, LSTEPS, LDEPTH, LRISE, 0.95, LSEG_W * 0.5 - 0.6, LANDO_PALETTE);
  });
  for (const im of [landoSteps, landoRoofs, landoWalls, landoPosts]) {
    im.castShadow = true;
    im.frustumCulled = false;
  }
  landoSteps.receiveShadow = true;
  landoBanners.frustumCulled = false;
  group.add(landoSteps, landoRoofs, landoBanners, landoWalls, landoPosts);

  // build the single shared crowd mesh from every stand's collected clusters
  const crowdGeo = new THREE.BoxGeometry(0.9, 0.85, 0.5);
  crowdGeo.translate(0, 0.42, 0); // base at instance y
  const crowdMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdMats.length);
  for (let i = 0; i < crowdMats.length; i++) {
    crowd.setMatrixAt(i, crowdMats[i]);
    crowd.setColorAt(i, crowdCols[i]);
  }
  crowd.instanceMatrix.needsUpdate = true;
  if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
  crowd.castShadow = false;
  crowd.receiveShadow = false;
  crowd.frustumCulled = false;
  group.add(crowd);

  // ---------------------------------------------------------------- the Wing (pits)
  const wingBlockGeo = new THREE.BoxGeometry(22, 9, 88);
  const wingBlockMat = new THREE.MeshStandardMaterial({ color: 0xdfe3e7, roughness: 0.45, metalness: 0.25 });
  const wingRoofGeo = new THREE.BoxGeometry(26, 0.8, 92);
  const wingRoofMat = new THREE.MeshStandardMaterial({ color: 0xb8bfc7, roughness: 0.4, metalness: 0.45 });
  const wingGlassGeo = new THREE.BoxGeometry(22.3, 2.2, 88.3);
  const wingGlassMat = new THREE.MeshStandardMaterial({ color: 0x27313e, roughness: 0.15, metalness: 0.7 });
  const WING_SEGMENTS = [5875, 5965, track.length + 168, track.length + 258].map((s) => s % track.length);
  const wingBlocks = new THREE.InstancedMesh(wingBlockGeo, wingBlockMat, WING_SEGMENTS.length);
  const wingRoofs = new THREE.InstancedMesh(wingRoofGeo, wingRoofMat, WING_SEGMENTS.length);
  const wingGlass = new THREE.InstancedMesh(wingGlassGeo, wingGlassMat, WING_SEGMENTS.length);
  WING_SEGMENTS.forEach((s, i) => {
    const p = trackAt(track, s);
    const dist = p.wRight + 20 + 11; // facade ~20 m off the track edge
    const basePos = simToWorld(p.x - dist * p.nx, p.y - dist * p.ny);
    q.setFromAxisAngle(UP, yawTo(simDirToWorld(p.tx, p.ty).normalize()));
    scl.set(1, 1, 1);
    m4.compose(pos.copy(basePos).setY(4.5), q, scl);
    wingBlocks.setMatrixAt(i, m4);
    m4.compose(pos.copy(basePos).setY(9.4), q, scl);
    wingRoofs.setMatrixAt(i, m4);
    m4.compose(pos.copy(basePos).setY(5.2), q, scl);
    wingGlass.setMatrixAt(i, m4);
  });
  for (const im of [wingBlocks, wingRoofs, wingGlass]) {
    im.castShadow = true;
    im.frustumCulled = false;
    group.add(im);
  }

  // pit wall between track and pit lane
  const wallPose = trackAt(track, 95);
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 1.1, 330),
    new THREE.MeshStandardMaterial({ color: 0xdadfe3, roughness: 0.6 }),
  );
  wall.position.copy(simToWorld(
    wallPose.x - (wallPose.wRight + 2.8) * wallPose.nx,
    wallPose.y - (wallPose.wRight + 2.8) * wallPose.ny,
  )).setY(0.55);
  wall.rotation.y = yawTo(simDirToWorld(wallPose.tx, wallPose.ty).normalize());
  wall.castShadow = true;
  group.add(wall);

  // ---------------------------------------------------------------- tree lines
  // Mixed perimeter woodland: tiered conifers + rounded deciduous canopies,
  // each with a generated foliage texture and per-instance scale / rotation /
  // hue variance so the tree line never reads as a repeated stamp. Two canopy
  // InstancedMeshes + one shared trunk mesh (3 draw calls total).
  interface Tree { x: number; z: number; conifer: boolean; r: number; h: number; trunkH: number; yaw: number }
  const trees: Tree[] = [];
  for (let s = 0; s < track.length; s += 29) {
    const p = trackAt(track, s + rng() * 26);
    const side = rng() < 0.5 ? 1 : -1;
    const dist = 55 + rng() * 120;
    const sx = p.x + side * dist * p.nx;
    const sy = p.y + side * dist * p.ny;
    let minD = Infinity;
    for (let i = 0; i < track.samples.length; i += 3) {
      const smp = track.samples[i];
      const d = (smp.x - sx) * (smp.x - sx) + (smp.y - sy) * (smp.y - sy);
      if (d < minD) minD = d;
    }
    if (minD < 30 * 30) continue;
    const conifer = rng() < 0.55;
    trees.push({
      x: sx, z: -sy, conifer, yaw: rng() * Math.PI * 2,
      r: conifer ? 1.7 + rng() * 1.3 : 2.4 + rng() * 1.8,
      h: conifer ? 7 + rng() * 5 : 4.5 + rng() * 2.5,
      trunkH: conifer ? 0.6 + rng() * 0.5 : 2.0 + rng() * 1.2,
    });
  }

  // needly conifer foliage: dark pine with vertical streaks + highlights
  const coniferTex = makeCanvasTexture(96, 96, (ctx, w, h) => {
    paintNoise(ctx, w, h, [44, 78, 44], 10, rng);
    for (let i = 0; i < 220; i++) {
      const dark = rng() < 0.5;
      ctx.fillStyle = dark ? 'rgba(24,48,26,0.5)' : 'rgba(96,132,74,0.45)';
      ctx.fillRect(rng() * w, rng() * h, 1, 3 + rng() * 7);
    }
  });
  coniferTex.repeat.set(2, 3);
  // leafy deciduous foliage: mottled light/dark green clumps
  const decidTex = makeCanvasTexture(96, 96, (ctx, w, h) => {
    paintNoise(ctx, w, h, [74, 112, 52], 12, rng);
    for (let i = 0; i < 150; i++) {
      const light = rng() < 0.5;
      ctx.fillStyle = light ? 'rgba(118,156,84,0.5)' : 'rgba(48,82,40,0.5)';
      ctx.beginPath();
      ctx.arc(rng() * w, rng() * h, 2 + rng() * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  decidTex.repeat.set(2, 2);

  // tiered fir silhouette in one lathe (radius up to 1, height 1; scaled per tree)
  const coniferGeo = new THREE.LatheGeometry([
    [0.02, 0.0], [1.0, 0.03], [0.55, 0.30], [0.80, 0.33],
    [0.42, 0.58], [0.60, 0.61], [0.26, 0.82], [0.38, 0.84], [0.0, 1.0],
  ].map(([r, y]) => new THREE.Vector2(r, y)), 8);
  // rounded, slightly lumpy deciduous canopy (unit radius; jittered once)
  const decidGeo = new THREE.IcosahedronGeometry(1, 2);
  {
    const pa = decidGeo.getAttribute('position') as THREE.BufferAttribute;
    const jr = mulberry32(99);
    for (let i = 0; i < pa.count; i++) {
      const f = 0.88 + jr() * 0.2;
      pa.setXYZ(i, pa.getX(i) * f, pa.getY(i) * f * 0.9, pa.getZ(i) * f);
    }
    decidGeo.computeVertexNormals();
  }
  const foliageMat = (map: THREE.Texture): THREE.MeshStandardMaterial =>
    // white base: per-instance color carries the green + hue variance
    new THREE.MeshStandardMaterial({ color: 0xffffff, map, roughness: 1, vertexColors: false });

  const nConifer = trees.filter((t) => t.conifer).length;
  const conifers = new THREE.InstancedMesh(coniferGeo, foliageMat(coniferTex), nConifer);
  const deciduous = new THREE.InstancedMesh(decidGeo, foliageMat(decidTex), trees.length - nConifer);
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1, 6);
  trunkGeo.translate(0, 0.5, 0); // base at ground; per-instance y-scale = trunkH
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5d4a33, roughness: 1 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const cq = new THREE.Quaternion();
  let ci = 0;
  let di = 0;
  trees.forEach((t, i) => {
    cq.setFromAxisAngle(UP, t.yaw);
    // canopy tint: subtle per-instance brightness + green/warmth jitter
    const v = 0.82 + rng() * 0.32;
    const col = new THREE.Color(v * (0.92 + (rng() - 0.5) * 0.1), v * (1.0 + (rng() - 0.5) * 0.14), v * 0.82);
    if (t.conifer) {
      m4.compose(pos.set(t.x, t.trunkH * 0.5, t.z), cq, scl.set(t.r, t.h, t.r));
      conifers.setMatrixAt(ci, m4);
      conifers.setColorAt(ci, col);
      ci++;
    } else {
      m4.compose(pos.set(t.x, t.trunkH + t.h * 0.42, t.z), cq, scl.set(t.r, t.h * 0.6, t.r));
      deciduous.setMatrixAt(di, m4);
      deciduous.setColorAt(di, col);
      di++;
    }
    m4.compose(pos.set(t.x, 0, t.z), cq, scl.set(1, t.trunkH, 1));
    trunks.setMatrixAt(i, m4);
  });
  conifers.castShadow = true;
  conifers.frustumCulled = false;
  deciduous.castShadow = true;
  deciduous.frustumCulled = false;
  trunks.frustumCulled = false;
  group.add(conifers, deciduous, trunks);

  // ---------------------------------------------------------------- marshal flags
  const FLAG_POSTS: Array<{ s: number; side: 1 | -1; color: number }> = [
    { s: 385, side: 1, color: 0xf3c614 },  // Abbey
    { s: 890, side: 1, color: 0x2255dd },  // Village
    { s: 2000, side: -1, color: 0xf3c614 },// Brooklands
    { s: 2170, side: 1, color: 0x2ec24e }, // Luffield
    { s: 3130, side: 1, color: 0xf3c614 }, // Copse
    { s: 3610, side: -1, color: 0x2255dd },// Maggotts
    { s: 5080, side: 1, color: 0xf3c614 }, // Stowe
    { s: 5590, side: 1, color: 0x2ec24e }, // Club
  ];
  const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6);
  postGeo.translate(0, 1.3, 0);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5 });
  const posts = new THREE.InstancedMesh(postGeo, postMat, FLAG_POSTS.length);
  const flagGeo = new THREE.PlaneGeometry(1.0, 0.65);
  flagGeo.translate(0.5, 0, 0);
  const flagMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide });
  const flags = new THREE.InstancedMesh(flagGeo, flagMat, FLAG_POSTS.length);
  FLAG_POSTS.forEach((f, i) => {
    const p = trackAt(track, f.s);
    const w = f.side > 0 ? p.wLeft : p.wRight;
    const base = simToWorld(p.x + f.side * (w + 6) * p.nx, p.y + f.side * (w + 6) * p.ny);
    q.setFromAxisAngle(UP, yawTo(simDirToWorld(p.tx, p.ty).normalize()) + 0.4);
    m4.compose(pos.copy(base).setY(0), q, scl.set(1, 1, 1));
    posts.setMatrixAt(i, m4);
    m4.compose(pos.copy(base).setY(2.25), q, scl.set(1, 1, 1));
    flags.setMatrixAt(i, m4);
    flags.setColorAt(i, new THREE.Color(f.color));
  });
  posts.frustumCulled = false;
  flags.frustumCulled = false;
  group.add(posts, flags);

  // ---------------------------------------------------------------- armco barriers
  // Steel guardrail lining the outside of the fast corners — instanced short
  // segments laid along the tangent just beyond the run-off. Two rails on a
  // dark post, merged per segment so the whole set is one InstancedMesh.
  const BARRIERS: Array<{ s0: number; s1: number; side: 1 | -1; off: number }> = [
    { s0: 3050, s1: 3230, side: 1, off: 24 },   // Copse (beyond the gravel)
    { s0: 3520, s1: 3760, side: -1, off: 12 },  // Maggotts / Becketts entry
    { s0: 4960, s1: 5200, side: 1, off: 29 },   // Stowe (beyond the gravel)
  ];
  const SEG = 6; // segment length (m)
  const railGeo = new THREE.BoxGeometry(0.14, 0.16, SEG);
  const barrierSegGeo = mergeGeometries([
    railGeo.clone().translate(0, 0.72, 0),                     // top rail
    railGeo.clone().translate(0, 0.46, 0),                     // lower rail
    new THREE.BoxGeometry(0.1, 0.85, 0.1).translate(0, 0.42, -SEG / 2 + 0.1), // post
  ], false)!;
  const barrierMat = new THREE.MeshStandardMaterial({ color: 0xb9bfc6, roughness: 0.45, metalness: 0.65 });
  const barrierSpecs: Array<{ s: number; side: 1 | -1; off: number }> = [];
  for (const b of BARRIERS) {
    for (let s = b.s0; s <= b.s1; s += SEG) barrierSpecs.push({ s, side: b.side, off: b.off });
  }
  const barriers = new THREE.InstancedMesh(barrierSegGeo, barrierMat, barrierSpecs.length);
  barrierSpecs.forEach((b, i) => {
    const p = trackAt(track, b.s);
    const w = b.side > 0 ? p.wLeft : p.wRight;
    const base = simToWorld(p.x + b.side * (w + b.off) * p.nx, p.y + b.side * (w + b.off) * p.ny);
    q.setFromAxisAngle(UP, yawTo(simDirToWorld(p.tx, p.ty).normalize()));
    m4.compose(pos.copy(base).setY(0), q, scl.set(1, 1, 1));
    barriers.setMatrixAt(i, m4);
  });
  barriers.castShadow = true;
  barriers.frustumCulled = false;
  group.add(barriers);

  return group;
}
