/**
 * Tiny localStorage-backed persistence: the first-run onboarding flag and the
 * player's Time-Trial best lap (time + the deploy map that set it + a ghost
 * trace to race against). All reads/writes are guarded so a disabled or full
 * localStorage never throws.
 */
import type { DeployMap } from '../sim/types';

const KEY = 'override-silverstone-v1';

/** ghost trace: parallel arrays of lap-time (s) and arc length (m) samples. */
export interface GhostTrace {
  t: number[];
  s: number[];
}

export interface BestLap {
  time: number;
  map: DeployMap;
  ghost: GhostTrace;
}

interface Store {
  seenOnboarding?: boolean;
  bestLap?: BestLap;
}

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Store;
  } catch {
    return {};
  }
}

function write(s: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — records just don't persist */
  }
}

export function hasSeenOnboarding(): boolean {
  return read().seenOnboarding === true;
}
export function setSeenOnboarding(): void {
  const s = read();
  s.seenOnboarding = true;
  write(s);
}
/** test/debug helper — force the tutorial to show again next load */
export function resetOnboarding(): void {
  const s = read();
  delete s.seenOnboarding;
  write(s);
}

export function getBestLap(): BestLap | null {
  return read().bestLap ?? null;
}

/** Save a lap only if it beats the stored best. Returns true if it was a record. */
export function saveBestLapIfBetter(lap: BestLap): boolean {
  const s = read();
  if (s.bestLap && s.bestLap.time <= lap.time) return false;
  s.bestLap = lap;
  write(s);
  return true;
}
