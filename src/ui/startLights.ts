/**
 * F1 start-lights gantry — the real Silverstone launch sequence.
 *
 * A centered, broadcast-style start gantry: five lamp columns (each with two
 * stacked red bulbs) illuminate left-to-right, one per ~1s. After all five are
 * lit the gantry holds for a short, randomized beat (like real F1, to defeat
 * anticipation), then ALL LIGHTS OUT simultaneously = go. On lights-out we fire
 * the caller's `onLightsOut`, flash "LIGHTS OUT", fade the gantry away, and
 * resolve `run()`.
 *
 * Self-contained: injects its own CSS via an id-guarded <style> (added once,
 * shared across instances). Nothing here touches screens.css / hud.css.
 *
 * Jump-start detection: `isArmed()` is true from the instant the sequence
 * starts until the exact frame the lights go out. A boost/launch input while
 * `isArmed()` is true is, by definition, a jump start.
 */

export interface StartLightsHandle {
  /** Run the 5-light sequence; resolves at lights-out. */
  run(opts?: { holdMs?: number; onLightsOut?: () => void }): Promise<void>;
  /** Cancel an in-progress sequence (e.g. user quit); hides the gantry. */
  abort(): void;
  /** True once the sequence starts, false the instant lights go out. */
  isArmed(): boolean;
  destroy(): void;
}

const STYLE_ID = 'f1-start-lights-style';
const COLUMNS = 5;
const BULBS_PER_COLUMN = 2;

const FADE_IN_MS = 260; // gantry settles in before the first light
const LIGHT_INTERVAL_MS = 1000; // canonical: one column per second
const HOLD_MIN_MS = 800; // random hold window after the 5th light...
const HOLD_MAX_MS = 2500; // ...before lights-out (defeats anticipation)
const GO_HOLD_MS = 620; // how long "LIGHTS OUT" holds before the fade
const FADE_OUT_MS = 520; // gantry fade-away duration

export function createStartLights(container: HTMLElement): StartLightsHandle {
  injectStyle();

  // ---- DOM: root > stage > (gantry > columns > bulbs) + "LIGHTS OUT" flash
  const root = document.createElement('div');
  root.className = 'f1sl-root';

  const stage = document.createElement('div');
  stage.className = 'f1sl-stage';

  const gantry = document.createElement('div');
  gantry.className = 'f1sl-gantry';

  const columns: HTMLElement[][] = [];
  const allBulbs: HTMLElement[] = [];
  for (let c = 0; c < COLUMNS; c++) {
    const col = document.createElement('div');
    col.className = 'f1sl-col';
    const bulbs: HTMLElement[] = [];
    for (let b = 0; b < BULBS_PER_COLUMN; b++) {
      const bulb = document.createElement('div');
      bulb.className = 'f1sl-bulb';
      col.appendChild(bulb);
      bulbs.push(bulb);
      allBulbs.push(bulb);
    }
    columns.push(bulbs);
    gantry.appendChild(col);
  }

  const go = document.createElement('div');
  go.className = 'f1sl-go';
  go.textContent = 'LIGHTS OUT';

  stage.appendChild(gantry);
  stage.appendChild(go);
  root.appendChild(stage);
  container.appendChild(root);

  // ---- cancellable-timer plumbing (so abort/destroy unwind cleanly)
  let generation = 0;
  let armed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wakers = new Set<() => void>();

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const id = setTimeout(() => {
        timers.delete(id);
        wakers.delete(resolve);
        resolve();
      }, ms);
      timers.add(id);
      wakers.add(resolve);
    });

  // fire-and-forget scheduled callback (tracked, so abort clears it)
  const later = (fn: () => void, ms: number): void => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  const cancelPending = (): void => {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    // settle any awaiting sleep so an in-flight run() unwinds to its gen check
    for (const wake of wakers) wake();
    wakers.clear();
  };

  const resetVisual = (): void => {
    root.classList.remove('is-visible', 'is-fading', 'is-go');
    for (const bulb of allBulbs) bulb.classList.remove('is-lit');
  };

  const setColumnLit = (index: number, lit: boolean): void => {
    for (const bulb of columns[index]) bulb.classList.toggle('is-lit', lit);
  };

  async function run(opts?: { holdMs?: number; onLightsOut?: () => void }): Promise<void> {
    cancelPending(); // stop any prior sequence / lingering fade
    const gen = ++generation;
    armed = true;
    resetVisual();

    // reflow so the fade-in transition actually plays from opacity 0
    void root.offsetWidth;
    root.classList.add('is-visible');

    await sleep(FADE_IN_MS);
    if (gen !== generation) return;

    for (let i = 0; i < COLUMNS; i++) {
      await sleep(LIGHT_INTERVAL_MS);
      if (gen !== generation) return;
      setColumnLit(i, true);
    }

    const hold = opts?.holdMs ?? HOLD_MIN_MS + Math.random() * (HOLD_MAX_MS - HOLD_MIN_MS);
    await sleep(hold);
    if (gen !== generation) return;

    // ---- LIGHTS OUT — the gameplay trigger fires here, exactly once.
    for (let i = 0; i < COLUMNS; i++) setColumnLit(i, false);
    armed = false;
    root.classList.add('is-go');
    opts?.onLightsOut?.();

    // Flash + fade the gantry away asynchronously — run() resolves at
    // lights-out (below) so the race launches immediately, not after the fade.
    later(() => {
      if (gen !== generation) return;
      root.classList.add('is-fading');
      root.classList.remove('is-visible');
    }, GO_HOLD_MS);
    later(() => {
      if (gen !== generation) return;
      resetVisual();
    }, GO_HOLD_MS + FADE_OUT_MS);
  }

  function abort(): void {
    generation++; // invalidate any in-flight run
    cancelPending();
    armed = false;
    resetVisual();
  }

  function destroy(): void {
    abort();
    root.remove();
    // The shared <style> is id-guarded and harmless; leave it for other instances.
  }

  return {
    run,
    abort,
    isArmed: () => armed,
    destroy,
  };
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.f1sl-root {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  user-select: none;
  opacity: 0;
  transition: opacity ${FADE_IN_MS}ms ease;
  font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
.f1sl-root.is-visible { opacity: 1; }
.f1sl-root.is-fading { transition-duration: ${FADE_OUT_MS}ms; }

/* soft vignette so the gantry reads over any 3D backdrop */
.f1sl-root::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(62% 54% at 50% 42%, rgba(0, 0, 0, 0.30), rgba(0, 0, 0, 0.58));
  opacity: 0;
  transition: opacity ${FADE_IN_MS}ms ease;
}
.f1sl-root.is-visible::before { opacity: 1; }

.f1sl-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(16px, 2.4vh, 34px);
  transform: translateY(-4vh);
}

.f1sl-gantry {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: clamp(10px, 1.5vw, 22px);
  padding: clamp(15px, 1.9vw, 27px) clamp(17px, 2.1vw, 32px);
  border-radius: 14px;
  background: linear-gradient(180deg, #191d24 0%, #0d1015 58%, #090b0f 100%);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-top-color: rgba(255, 255, 255, 0.17);
  box-shadow:
    0 20px 64px rgba(0, 0, 0, 0.62),
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    inset 0 -3px 10px rgba(0, 0, 0, 0.7);
}

/* mounting struts above the beam — broadcast gantry detail */
.f1sl-gantry::before,
.f1sl-gantry::after {
  content: '';
  position: absolute;
  top: clamp(-22px, -1.5vw, -14px);
  width: clamp(5px, 0.6vw, 8px);
  height: clamp(14px, 1.5vw, 22px);
  background: linear-gradient(180deg, #2b313b, #12151b);
  border-radius: 3px 3px 0 0;
}
.f1sl-gantry::before { left: 20%; }
.f1sl-gantry::after { right: 20%; }

.f1sl-col {
  display: flex;
  flex-direction: column;
  gap: clamp(8px, 1.1vw, 16px);
  padding: clamp(8px, 1vw, 14px) clamp(9px, 1.1vw, 15px);
  border-radius: 10px;
  background: linear-gradient(180deg, #05070a, #010203);
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.9),
    inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

.f1sl-bulb {
  position: relative;
  width: clamp(34px, 4vw, 62px);
  height: clamp(34px, 4vw, 62px);
  border-radius: 50%;
  background: radial-gradient(circle at 38% 34%, #3a0d0d 0%, #1e0606 46%, #0a0202 100%);
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.85),
    inset 0 -3px 7px rgba(120, 20, 20, 0.16);
  transition: background 90ms ease, box-shadow 90ms ease;
}

/* recessed lens rim */
.f1sl-bulb::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow: inset 0 0 0 clamp(3px, 0.5vw, 6px) rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

.f1sl-bulb.is-lit {
  background: radial-gradient(circle at 40% 33%, #ff9273 0%, #ff2d1e 34%, #e50d0d 62%, #a60505 100%);
  box-shadow:
    0 0 13px 2px rgba(255, 44, 28, 0.78),
    0 0 38px 9px rgba(255, 32, 20, 0.42),
    inset 0 0 11px rgba(255, 222, 205, 0.38),
    inset 0 2px 5px rgba(255, 255, 255, 0.28);
}

.f1sl-go {
  font-size: clamp(30px, 5vw, 68px);
  font-weight: 900;
  letter-spacing: 0.14em;
  color: #2effa0;
  text-shadow: 0 0 26px rgba(46, 255, 160, 0.72), 0 4px 30px rgba(0, 0, 0, 0.6);
  opacity: 0;
  transform: scale(0.86);
  transition: opacity 120ms ease, transform 240ms cubic-bezier(0.2, 1.4, 0.4, 1);
}
.f1sl-root.is-go .f1sl-go { opacity: 1; transform: scale(1); }
`;
