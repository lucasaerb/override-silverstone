/**
 * Camera rig: one PerspectiveCamera driven in three modes.
 *
 *  - 'chase'    : TV-style behind-car camera, critically damped springs on
 *                 position and look target (no lag jitter), FOV widens with
 *                 speed (60 -> 70).
 *  - 'onboard'  : driver head height, looks along the tangent, subtle
 *                 speed-scaled shake.
 *  - 'trackside': ~10 fixed positions near the famous corners; auto-cuts to
 *                 the nearest one ahead of the car (held until the car is
 *                 ~45 m past), distance-based zoom for the classic broadcast
 *                 long-lens feel.
 */
import * as THREE from 'three';
import type { TrackData } from '../sim/types';
import { trackAt, wrapS } from '../sim/track';
import { simToWorld } from './scene';

export type CameraMode = 'chase' | 'onboard' | 'trackside';

export interface CarView {
  position: THREE.Vector3;
  /** unit forward (world) */
  forward: THREE.Vector3;
  s: number;
  /** m/s */
  speed: number;
}

/** trackside spots: s along lap, side (+1 = left of travel), lateral gap, height */
const TRACKSIDE_SPECS: Array<{ s: number; side: 1 | -1; dist: number; h: number }> = [
  { s: 430, side: 1, dist: 20, h: 6 },     // Abbey exit
  { s: 930, side: 1, dist: 18, h: 5 },     // Village
  { s: 1120, side: -1, dist: 16, h: 4.5 }, // The Loop / Aintree
  { s: 2055, side: -1, dist: 20, h: 6 },   // Brooklands
  { s: 2240, side: 1, dist: 17, h: 5 },    // Luffield
  { s: 3180, side: 1, dist: 22, h: 6.5 },  // Copse
  { s: 4060, side: 1, dist: 20, h: 6 },    // Becketts
  { s: 4650, side: -1, dist: 18, h: 5 },   // Hangar Straight
  { s: 5140, side: 1, dist: 22, h: 6 },    // Stowe
  { s: 5755, side: 1, dist: 19, h: 5.5 },  // Club exit
];

/** how far past a trackside camera the car gets before cutting ahead, m */
const TRACKSIDE_HOLD = 45;

/**
 * Critically damped spring toward `target` (Unity SmoothDamp form) — smooth,
 * overshoot-free, frame-rate independent.
 */
function springDamp(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  target: THREE.Vector3,
  omega: number,
  dt: number,
): void {
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  for (const axis of ['x', 'y', 'z'] as const) {
    const change = pos[axis] - target[axis];
    const temp = (vel[axis] + omega * change) * dt;
    vel[axis] = (vel[axis] - omega * temp) * decay;
    pos[axis] = target[axis] + (change + temp) * decay;
  }
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private mode: CameraMode = 'chase';
  private readonly track: TrackData;
  private readonly spots: Array<{ pos: THREE.Vector3; s: number }>;
  private spotIdx = -1;

  private readonly camPos = new THREE.Vector3();
  private readonly camVel = new THREE.Vector3();
  private readonly lookPos = new THREE.Vector3();
  private readonly lookVel = new THREE.Vector3();
  private fov = 62;
  private shakeT = 0;
  private snapNext = true;

  // scratch
  private readonly target = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor(track: TrackData, aspect: number) {
    this.track = track;
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.8, 6000);
    this.spots = TRACKSIDE_SPECS.map((spec) => {
      const p = trackAt(track, spec.s);
      const w = spec.side > 0 ? p.wLeft : p.wRight;
      const off = spec.side * (w + spec.dist);
      const pos = simToWorld(p.x + off * p.nx, p.y + off * p.ny, new THREE.Vector3());
      pos.y = spec.h;
      return { pos, s: spec.s };
    });
  }

  getMode(): CameraMode {
    return this.mode;
  }

  setCamera(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.snapNext = true;
    this.spotIdx = -1;
  }

  cycle(): void {
    const order: CameraMode[] = ['chase', 'onboard', 'trackside'];
    this.setCamera(order[(order.indexOf(this.mode) + 1) % order.length]);
  }

  update(dt: number, car: CarView): void {
    switch (this.mode) {
      case 'chase':
        this.updateChase(dt, car);
        break;
      case 'onboard':
        this.updateOnboard(dt, car);
        break;
      case 'trackside':
        this.updateTrackside(dt, car);
        break;
    }
    this.snapNext = false;
  }

  private setFov(targetFov: number, dt: number, snap: boolean): void {
    this.fov = snap ? targetFov : this.fov + (targetFov - this.fov) * Math.min(1, dt * 4);
    if (Math.abs(this.camera.fov - this.fov) > 1e-3) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private updateChase(dt: number, car: CarView): void {
    // spring the OFFSET from the car, not the absolute position — the car
    // moves 60-90 m/s and an absolute spring would trail by v/omega (~13 m).
    // camPos/lookPos hold offsets relative to the car in this mode.
    this.target.copy(car.forward).multiplyScalar(-9);
    this.target.y += 3;
    this.lookTarget.copy(car.forward).multiplyScalar(6);
    this.lookTarget.y += 0.9;
    if (this.snapNext) {
      this.camPos.copy(this.target);
      this.camVel.set(0, 0, 0);
      this.lookPos.copy(this.lookTarget);
      this.lookVel.set(0, 0, 0);
    } else {
      springDamp(this.camPos, this.camVel, this.target, 4.5, dt);
      springDamp(this.lookPos, this.lookVel, this.lookTarget, 8, dt);
    }
    this.camera.position.copy(car.position).add(this.camPos);
    this.right.copy(car.position).add(this.lookPos); // reuse scratch as look point
    this.camera.lookAt(this.right);
    const speedT = THREE.MathUtils.clamp((car.speed - 30) / 60, 0, 1);
    this.setFov(60 + 10 * speedT, dt, this.snapNext);
  }

  private updateOnboard(dt: number, car: CarView): void {
    this.shakeT += dt * (0.5 + car.speed / 40);
    const amp = 0.006 + 0.028 * THREE.MathUtils.clamp(car.speed / 90, 0, 1);
    const t = this.shakeT;
    const sway = (Math.sin(t * 57.3) + 0.6 * Math.sin(t * 151.7 + 1.3)) * amp;
    const bob = (Math.sin(t * 83.1 + 0.7) + 0.5 * Math.sin(t * 191.3)) * amp * 0.7;
    this.right.crossVectors(car.forward, this.camera.up).normalize();
    // T-cam position: just above/behind the cockpit opening
    this.camera.position
      .copy(car.position)
      .addScaledVector(car.forward, -0.35)
      .addScaledVector(this.right, sway);
    this.camera.position.y += 1.0 + bob;
    this.lookTarget
      .copy(this.camera.position)
      .addScaledVector(car.forward, 40)
      .addScaledVector(this.right, sway * 6);
    this.lookTarget.y += 0.4 + bob * 4;
    this.camera.lookAt(this.lookTarget);
    this.setFov(72 + 4 * THREE.MathUtils.clamp(car.speed / 90, 0, 1), dt, this.snapNext);
  }

  private updateTrackside(dt: number, car: CarView): void {
    // nearest camera ahead of a point HOLD meters behind the car, so the
    // active camera keeps filming while the car passes it.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.spots.length; i++) {
      const d = wrapS(this.track, this.spots[i].s - car.s + TRACKSIDE_HOLD);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const cut = best !== this.spotIdx || this.snapNext;
    this.spotIdx = best;
    const spot = this.spots[best];
    this.camera.position.copy(spot.pos);

    this.lookTarget.copy(car.position).addScaledVector(car.forward, 4);
    this.lookTarget.y += 0.5;
    if (cut) {
      this.lookPos.copy(this.lookTarget);
      this.lookVel.set(0, 0, 0);
    } else {
      springDamp(this.lookPos, this.lookVel, this.lookTarget, 12, dt);
    }
    this.camera.lookAt(this.lookPos);

    // broadcast long-lens: zoom keeps the car a similar size in frame
    const dist = this.camera.position.distanceTo(car.position);
    const targetFov = THREE.MathUtils.clamp(
      THREE.MathUtils.radToDeg(2 * Math.atan(5.5 / Math.max(dist, 12))),
      8,
      50,
    );
    this.setFov(targetFov, dt, cut);
  }
}
