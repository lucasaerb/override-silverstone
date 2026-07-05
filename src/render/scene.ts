/**
 * Renderer / scene / lighting setup for OVERRIDE: Silverstone.
 *
 * COORDINATE MAPPING — the single contract every render module relies on:
 *
 *     sim plane (x, y)        ->  Three.js world (x, 0, -y)
 *     sim tangent (tx, ty)    ->  (tx, 0, -ty)
 *     sim leftNormal (nx, ny) ->  (nx, 0, -ny)
 *
 * The track is flat at world y = 0 (elevation is out of scope). Although the
 * y -> -z map is a reflection, we view the XZ plane from +Y, so a top-down
 * view matches the sim plane exactly (+X right, sim +Y == world -Z, i.e.
 * up-screen); "left of the car" in sim remains the car's left in world space.
 *
 * Rendering choices: WebGLRenderer (NOT WebGPU — headless/Puppeteer
 * testability requirement), ACES filmic tone mapping + sRGB output (r185
 * defaults, set explicitly), PCF soft shadows from one warm directional sun
 * at ~35° elevation (late-afternoon British summer) + hemisphere ambient,
 * scene fog for depth, pixel ratio capped at 2.
 *
 * The sun's shadow camera is a 150 m ortho box that FOLLOWS the car (snapped
 * to shadow-map texels to avoid crawling edges) so the car/kerb shadows stay
 * crisp on a 5.9 km track with a single 2048 map.
 */
import * as THREE from 'three';

export function simToWorld(x: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, 0, -y);
}

export function simDirToWorld(dx: number, dy: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(dx, 0, -dy);
}

/** Late-afternoon sun direction (unit, pointing FROM the scene TO the sun). */
export const SUN_DIRECTION = (() => {
  const el = THREE.MathUtils.degToRad(35);
  const az = THREE.MathUtils.degToRad(205);
  return new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az),
  ).normalize();
})();

const SHADOW_HALF = 75;
const SHADOW_MAP = 2048;

export interface SceneHandles {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  /** camera whose aspect the resize handler keeps in sync */
  registerCamera(camera: THREE.PerspectiveCamera): void;
  /** recenter the sun's shadow frustum around a world point (the car) */
  updateShadowFocus(worldPos: THREE.Vector3): void;
}

export function createScene(container: HTMLElement): SceneHandles {
  // logarithmicDepthBuffer: the track is layered in centimeters (asphalt /
  // decals / kerbs / grass) but broadcast cameras see it from 500+ m — a
  // standard depth buffer z-fights at that range, log depth is sub-mm there.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // fog + background match the sky dome's warm hazy horizon (environment.ts)
  // so distant track edges, grandstands and the tree line dissolve into the
  // haze instead of cutting off against a flat band.
  scene.background = new THREE.Color(0xc6d0d2);
  scene.fog = new THREE.Fog(0xc6d0d2, 620, 3400);

  const hemi = new THREE.HemisphereLight(0xbcd3ee, 0x6a7248, 0.82);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffdcae, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.camera.left = -SHADOW_HALF;
  sun.shadow.camera.right = SHADOW_HALF;
  sun.shadow.camera.top = SHADOW_HALF;
  sun.shadow.camera.bottom = -SHADOW_HALF;
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 900;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.5;
  scene.add(sun);
  scene.add(sun.target);

  let camera: THREE.PerspectiveCamera | null = null;
  const onResize = (): void => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  };
  window.addEventListener('resize', onResize);

  // world-space size of one shadow texel — snap the focus to this grid so
  // shadow edges don't shimmer as the frustum follows the car.
  const texel = (2 * SHADOW_HALF) / SHADOW_MAP;
  const focus = new THREE.Vector3();

  return {
    renderer,
    scene,
    sun,
    registerCamera(cam: THREE.PerspectiveCamera): void {
      camera = cam;
      cam.aspect = container.clientWidth / container.clientHeight;
      cam.updateProjectionMatrix();
    },
    updateShadowFocus(worldPos: THREE.Vector3): void {
      focus.set(
        Math.round(worldPos.x / texel) * texel,
        0,
        Math.round(worldPos.z / texel) * texel,
      );
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(SUN_DIRECTION, 420);
    },
  };
}
