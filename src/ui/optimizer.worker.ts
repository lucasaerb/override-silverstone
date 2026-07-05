/**
 * Web Worker host for the (potentially several-second) deployment optimizer and
 * zone-value analysis, so the strategy/result screens stay responsive while the
 * solver runs hundreds of race simulations. Pure sim code — no DOM, no three.js.
 */
import type { TrackData } from '../sim/types';
import { optimizeDeployMap, zoneValueAnalysis, type OptimizeOptions } from '../sim/optimizer';

interface OptimizeMsg { id: number; kind: 'optimize'; track: TrackData; opts?: OptimizeOptions }
interface AnalyzeMsg { id: number; kind: 'analyze'; track: TrackData }
type InMsg = OptimizeMsg | AnalyzeMsg;

// worker global scope, typed minimally to avoid DOM/webworker lib conflicts
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage: (message: unknown) => void;
};

ctx.onmessage = (e: MessageEvent<InMsg>): void => {
  const msg = e.data;
  try {
    if (msg.kind === 'optimize') {
      const result = optimizeDeployMap(msg.track, {
        ...msg.opts,
        onProgress: (fraction) => ctx.postMessage({ id: msg.id, kind: 'progress', fraction }),
      });
      ctx.postMessage({ id: msg.id, kind: 'result', result });
    } else {
      const result = zoneValueAnalysis(msg.track);
      ctx.postMessage({ id: msg.id, kind: 'result', result });
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, kind: 'error', message: String(err) });
  }
};
