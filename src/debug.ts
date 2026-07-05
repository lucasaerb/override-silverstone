/**
 * window.__game — the deterministic control surface for Puppeteer /
 * chrome-devtools E2E tests. Thin adapter: main.ts supplies the hooks (which
 * hold the real game state), this wraps them into the GameDebugApi contract
 * and captures uncaught errors.
 *
 * Determinism guarantee: a fixed seed plus a fixed script of these calls
 * (step / setBoost / setDeploy / goto) reproduces a race tick-for-tick, since
 * the sim's only rng is seeded and step() advances exact SIM.DT ticks.
 */
import type { DeployMap, GameDebugApi, RaceState } from './sim/types';

export interface DebugHooks {
  getState(): RaceState;
  step(n: number): void;
  setTimeScale(scale: number): void;
  setSeed(seed: number): void;
  setDeploy(carId: 'player' | 'rival', zoneId: number, level: number): void;
  setBoost(held: boolean): void;
  setCamera(name: 'chase' | 'onboard' | 'trackside'): void;
  getScreen(): string;
  goto(screen: 'menu' | 'modeselect' | 'strategy' | 'race' | 'result' | 'lobby'): void;
  getProjection(): { lapTime: number; deployedMJ: number } | null;
  setMap(carId: 'player' | 'rival', map: DeployMap): void;
  getMode(): string;
  setMode(mode: string): void;
}

export function installDebugApi(hooks: DebugHooks, errors: string[]): GameDebugApi {
  const api: GameDebugApi = {
    errors,
    getState: () => hooks.getState(),
    step: (n) => hooks.step(n),
    setTimeScale: (s) => hooks.setTimeScale(s),
    setSeed: (seed) => hooks.setSeed(seed),
    setDeploy: (carId, zoneId, level) => hooks.setDeploy(carId, zoneId, level),
    setBoost: (held) => hooks.setBoost(held),
    setCamera: (name) => hooks.setCamera(name),
    getScreen: () => hooks.getScreen(),
    goto: (screen) => hooks.goto(screen),
    getProjection: () => hooks.getProjection(),
    setMap: (carId, map) => hooks.setMap(carId, map),
    getMode: () => hooks.getMode(),
    setMode: (m) => hooks.setMode(m),
  };
  (window as unknown as { __game: GameDebugApi }).__game = api;
  return api;
}
