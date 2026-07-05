/**
 * Main-thread client for the optimizer Web Worker. Exposes two async calls that
 * both the strategy screen (SOLVE OPTIMAL, deploy-value heat-map) and the result
 * screen (post-race "you vs optimal") use. Results are cached per TrackData, so
 * the optimal map is computed once and reused everywhere — including across the
 * pre-race plan and the post-race analysis of the same track.
 */
import type { DeployMap, TrackData } from '../sim/types';
import type { OptimizeResult, ZoneValueAnalysis } from '../sim/optimizer';

let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

let nextId = 1;

function call<T>(
  kind: 'optimize' | 'analyze',
  track: TrackData,
  opts: unknown,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const w = getWorker();
    const id = nextId++;
    const handler = (e: MessageEvent): void => {
      const m = e.data;
      if (!m || m.id !== id) return;
      if (m.kind === 'progress') onProgress?.(m.fraction as number);
      else if (m.kind === 'result') { w.removeEventListener('message', handler); resolve(m.result as T); }
      else if (m.kind === 'error') { w.removeEventListener('message', handler); reject(new Error(m.message)); }
    };
    w.addEventListener('message', handler);
    w.postMessage({ id, kind, track, opts });
  });
}

const optimalCache = new WeakMap<TrackData, Promise<OptimizeResult>>();
const analysisCache = new WeakMap<TrackData, Promise<ZoneValueAnalysis>>();

/**
 * Optimal deployment map + sustainable lap time for a track. Cached per track
 * (the default solve); pass `force` to recompute. `onProgress` reports 0..1.
 */
export function solveOptimal(
  track: TrackData,
  onProgress?: (fraction: number) => void,
  force = false,
): Promise<OptimizeResult> {
  if (!force) {
    const cached = optimalCache.get(track);
    if (cached) { onProgress?.(1); return cached; }
  }
  const p = call<OptimizeResult>('optimize', track, { raceLaps: 3, maxSweeps: 3 }, onProgress);
  optimalCache.set(track, p);
  return p;
}

/** Per-zone deploy-value evidence for the heat-map. Cached per track. */
export function analyzeZones(track: TrackData): Promise<ZoneValueAnalysis> {
  const cached = analysisCache.get(track);
  if (cached) return cached;
  const p = call<ZoneValueAnalysis>('analyze', track, undefined);
  analysisCache.set(track, p);
  return p;
}

/** Cheap deep-clone for handing the optimal map to callers that mutate it. */
export function cloneMap(m: DeployMap): DeployMap {
  return { zoneDeploy: [...m.zoneDeploy], zoneLift: [...m.zoneLift] };
}
