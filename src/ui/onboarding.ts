/**
 * Generic onboarding "coach-mark / spotlight" tutorial engine.
 *
 * Self-contained + reusable: it injects its own CSS (once, id-guarded) and owns
 * no F1-specific knowledge. A caller supplies a step script; each step may
 * spotlight a DOM element (CSS selector) and/or switch screens via `onEnter`.
 *
 * On-brand with screens.css / hud.css: dark-glass card, papaya (#ff8412) accent
 * ring, teal for secondary, condensed sans, tabular numerals.
 *
 *   const onb = createOnboarding(document.getElementById('app')!);
 *   await onb.start([
 *     { title: 'Start here', body: 'Press <b>START</b>.', target: '.menu-start', requireClick: true },
 *     { title: 'All set', body: 'Good luck.' },
 *   ]);
 */

export interface OnbStep {
  title: string;
  body: string; // may contain simple <b>/<br> HTML
  target?: string; // CSS selector of element to spotlight (null = centered card)
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto'; // card side vs target
  requireClick?: boolean; // if true, advance only when the spotlighted target is clicked
  onEnter?: () => void | Promise<void>; // awaited before the target is measured
}

export interface OnboardingHandle {
  start(steps: OnbStep[]): Promise<void>; // resolves when finished or skipped
  stop(): void;
  isActive(): boolean;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const STYLE_ID = 'onb-styles';

const CSS = `
.onb-root {
  position: fixed;
  inset: 0;
  z-index: 100000;
  pointer-events: none;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #e8eef5;
  -webkit-font-smoothing: antialiased;
}
.onb-root *, .onb-root *::before, .onb-root *::after { box-sizing: border-box; }

/* full-screen dim + click-block for the no-target (centered) case */
.onb-veil {
  position: absolute;
  inset: 0;
  background: rgba(6, 10, 16, 0.72);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  pointer-events: auto;
  opacity: 0;
  transition: opacity 0.22s ease;
}
.onb-root.is-shown .onb-veil { opacity: 1; }

/* transparent click-blockers around the spotlight hole (4 panels) */
.onb-block { position: absolute; pointer-events: auto; background: transparent; }
/* transparent cover over the hole for non-clickable steps (stops stray clicks) */
.onb-holecover { position: absolute; pointer-events: auto; background: transparent; }

/* the spotlight cut-out: transparent rect, huge box-shadow dims everything else */
.onb-spotlight {
  position: absolute;
  border-radius: 12px;
  pointer-events: none;
  opacity: 0;
  box-shadow: 0 0 0 9999px rgba(6, 10, 16, 0.72);
  outline: 2px solid rgba(255, 132, 18, 0.95);
  outline-offset: 3px;
  transition: opacity 0.22s ease;
}
.onb-root.is-shown .onb-spotlight { opacity: 1; }
.onb-root.is-anim .onb-spotlight {
  transition: opacity 0.2s ease,
    left 0.28s cubic-bezier(0.4, 0, 0.2, 1), top 0.28s cubic-bezier(0.4, 0, 0.2, 1),
    width 0.28s cubic-bezier(0.4, 0, 0.2, 1), height 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}
/* soft papaya glow around the highlighted element */
.onb-spotlight::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: inherit;
  box-shadow: 0 0 0 2px rgba(255, 132, 18, 0.5), 0 0 26px 5px rgba(255, 132, 18, 0.35);
  pointer-events: none;
}
.onb-spotlight.is-clickable {
  outline-color: rgba(255, 132, 18, 1);
  animation: onb-ring-pulse 1.35s ease-in-out infinite;
}
@keyframes onb-ring-pulse {
  0%, 100% { outline-offset: 3px; outline-color: rgba(255, 132, 18, 1); }
  50% { outline-offset: 7px; outline-color: rgba(255, 132, 18, 0.35); }
}

/* coach card */
.onb-card {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: auto;
  width: min(360px, calc(100vw - 32px));
  background: rgba(22, 29, 40, 0.92);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
  box-shadow: 0 14px 50px rgba(0, 0, 0, 0.55);
  padding: 15px 17px 14px;
  opacity: 0;
  transform: translateY(6px) scale(0.985);
  transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}
.onb-root.is-shown .onb-card { opacity: 1; transform: none; }
.onb-root.is-anim .onb-card {
  transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.4, 0, 0.2, 1),
    left 0.28s cubic-bezier(0.4, 0, 0.2, 1), top 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}

.onb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.onb-kicker {
  font-size: 10px;
  letter-spacing: 0.22em;
  font-weight: 800;
  text-transform: uppercase;
  color: #ff8412;
  font-variant-numeric: tabular-nums;
}
.onb-title {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 0.01em;
  line-height: 1.25;
  margin: 8px 0 6px;
  color: #f2f6fb;
}
.onb-body {
  font-size: 13.5px;
  line-height: 1.55;
  color: #cdd6e0;
}
.onb-body b { color: #f2f6fb; font-weight: 750; }

.onb-hint {
  display: none;
  align-items: center;
  gap: 9px;
  margin-top: 13px;
  font-size: 12px;
  font-weight: 750;
  letter-spacing: 0.02em;
  color: #ffb162;
}
.onb-card.is-clickstep .onb-hint { display: flex; }
.onb-card.is-clickstep .onb-next { display: none; }
.onb-hint-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #ff8412;
  box-shadow: 0 0 8px rgba(255, 132, 18, 0.8);
  flex: 0 0 auto;
  animation: onb-hint-pulse 1s ease-in-out infinite;
}
@keyframes onb-hint-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.7); opacity: 0.45; }
}

.onb-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 15px;
}
.onb-dots { display: flex; align-items: center; gap: 6px; }
.onb-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.22);
  transition: background 0.2s ease, transform 0.2s ease;
}
.onb-dot.is-active {
  background: #ff8412;
  transform: scale(1.18);
  box-shadow: 0 0 8px rgba(255, 132, 18, 0.6);
}
.onb-btns { display: flex; align-items: center; gap: 8px; }

.onb-btn {
  font-family: inherit;
  font-weight: 650;
  font-size: 12.5px;
  letter-spacing: 0.04em;
  color: #e8eef5;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 9px;
  padding: 8px 15px;
  cursor: pointer;
  transition: background 0.14s, border-color 0.14s, transform 0.05s, opacity 0.14s;
}
.onb-btn:hover { background: rgba(255, 255, 255, 0.12); border-color: rgba(255, 255, 255, 0.3); }
.onb-btn:active { transform: translateY(1px); }
.onb-btn:disabled { opacity: 0.32; cursor: default; }
.onb-btn:disabled:hover { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.14); }
.onb-next {
  background: linear-gradient(180deg, #ff9a34, #ff8412);
  border-color: rgba(255, 180, 100, 0.6);
  color: #1a1206;
  font-weight: 800;
}
.onb-next:hover { background: linear-gradient(180deg, #ffab52, #ff8f22); border-color: rgba(255, 200, 130, 0.7); }
.onb-skip {
  background: transparent;
  border-color: transparent;
  color: #9aa6b4;
  padding: 6px 8px;
  font-size: 11.5px;
  letter-spacing: 0.06em;
}
.onb-skip:hover { color: #e8eef5; background: rgba(255, 255, 255, 0.07); border-color: transparent; }

/* pointer arrow (CSS triangle) attaching the card to its target */
.onb-arrow { position: absolute; width: 0; height: 0; pointer-events: none; display: none; }
`;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function createOnboarding(container: HTMLElement): OnboardingHandle {
  let steps: OnbStep[] = [];
  let index = 0;
  let active = false;
  let resolveFinish: (() => void) | null = null;

  // step-scoped state
  let curEl: HTMLElement | null = null;
  let curStep: OnbStep | null = null;
  let stepToken = 0; // bumped on every step change / stop; invalidates stale async work
  let targetClickHandler: ((e: Event) => void) | null = null;
  let settleRaf = 0;
  let settleUntil = 0;

  // DOM (assigned in build())
  let root: HTMLDivElement | null = null;
  let veil!: HTMLDivElement;
  let spotlight!: HTMLDivElement;
  let holeCover!: HTMLDivElement;
  let blocks: HTMLDivElement[] = [];
  let card!: HTMLDivElement;
  let kickerEl!: HTMLDivElement;
  let titleEl!: HTMLDivElement;
  let bodyEl!: HTMLDivElement;
  let dotsEl!: HTMLDivElement;
  let arrow!: HTMLDivElement;
  let backBtn!: HTMLButtonElement;
  let nextBtn!: HTMLButtonElement;
  let skipBtn!: HTMLButtonElement;

  function build(): void {
    injectStyles();
    const r = document.createElement('div');
    r.className = 'onb-root';
    r.innerHTML = `
      <div class="onb-veil"></div>
      <div class="onb-block onb-block-top"></div>
      <div class="onb-block onb-block-bottom"></div>
      <div class="onb-block onb-block-left"></div>
      <div class="onb-block onb-block-right"></div>
      <div class="onb-holecover"></div>
      <div class="onb-spotlight"></div>
      <div class="onb-card" role="dialog" aria-modal="true" aria-live="polite">
        <div class="onb-head">
          <div class="onb-kicker"></div>
          <button class="onb-btn onb-skip" type="button">Skip tour</button>
        </div>
        <div class="onb-title"></div>
        <div class="onb-body"></div>
        <div class="onb-hint"><span class="onb-hint-dot"></span><span class="onb-hint-txt">Click the highlighted control to continue</span></div>
        <div class="onb-foot">
          <div class="onb-dots"></div>
          <div class="onb-btns">
            <button class="onb-btn onb-back" type="button">Back</button>
            <button class="onb-btn onb-next" type="button">Next</button>
          </div>
        </div>
        <div class="onb-arrow"></div>
      </div>`;
    container.appendChild(r);
    root = r;

    veil = r.querySelector<HTMLDivElement>('.onb-veil')!;
    spotlight = r.querySelector<HTMLDivElement>('.onb-spotlight')!;
    holeCover = r.querySelector<HTMLDivElement>('.onb-holecover')!;
    blocks = Array.from(r.querySelectorAll<HTMLDivElement>('.onb-block'));
    card = r.querySelector<HTMLDivElement>('.onb-card')!;
    kickerEl = r.querySelector<HTMLDivElement>('.onb-kicker')!;
    titleEl = r.querySelector<HTMLDivElement>('.onb-title')!;
    bodyEl = r.querySelector<HTMLDivElement>('.onb-body')!;
    dotsEl = r.querySelector<HTMLDivElement>('.onb-dots')!;
    arrow = r.querySelector<HTMLDivElement>('.onb-arrow')!;
    backBtn = r.querySelector<HTMLButtonElement>('.onb-back')!;
    nextBtn = r.querySelector<HTMLButtonElement>('.onb-next')!;
    skipBtn = r.querySelector<HTMLButtonElement>('.onb-skip')!;

    backBtn.addEventListener('click', () => { if (index > 0) void goTo(index - 1); });
    nextBtn.addEventListener('click', () => void goTo(index + 1));
    skipBtn.addEventListener('click', () => finish());

    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey, true);
  }

  function onResize(): void { layout(); }

  function onKey(e: KeyboardEvent): void {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (index > 0) void goTo(index - 1); return; }
    if (e.key === 'Enter' || e.key === 'ArrowRight') {
      // Do not fast-forward past a step that demands a real click on the target.
      if (curStep && !(curStep.requireClick && curEl)) { e.preventDefault(); void goTo(index + 1); }
    }
  }

  function clearStepScope(): void {
    if (targetClickHandler && curEl) curEl.removeEventListener('click', targetClickHandler);
    targetClickHandler = null;
  }

  function pollSelector(sel: string, timeout: number, token: number): Promise<HTMLElement | null> {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (): void => {
        if (token !== stepToken || !active) { resolve(null); return; }
        const el = document.querySelector<HTMLElement>(sel);
        if (el) { resolve(el); return; }
        if (performance.now() - start >= timeout) { resolve(null); return; }
        window.setTimeout(tick, 40);
      };
      tick();
    });
  }

  async function goTo(i: number): Promise<void> {
    if (!active || !root) return;
    const token = ++stepToken;
    clearStepScope();

    index = clamp(i, 0, steps.length);
    if (index >= steps.length) { finish(); return; }
    const step = steps[index];
    curStep = step;

    if (step.onEnter) {
      try { await step.onEnter(); } catch { /* keep going even if the caller's hook throws */ }
    }
    if (token !== stepToken || !active) return;

    curEl = step.target ? await pollSelector(step.target, 1000, token) : null;
    if (token !== stepToken || !active) return;

    renderStep(step);
  }

  function renderStep(step: OnbStep): void {
    if (!root) return;

    kickerEl.textContent = `Step ${index + 1} of ${steps.length}`;
    titleEl.innerHTML = step.title;
    bodyEl.innerHTML = step.body;

    dotsEl.innerHTML = '';
    for (let k = 0; k < steps.length; k++) {
      const d = document.createElement('span');
      d.className = k === index ? 'onb-dot is-active' : 'onb-dot';
      dotsEl.appendChild(d);
    }

    const isLast = index === steps.length - 1;
    const isClick = !!step.requireClick && !!curEl;
    nextBtn.textContent = isLast ? "Let's go" : 'Next';
    backBtn.disabled = index === 0;
    card.classList.toggle('is-clickstep', isClick);

    if (curEl) {
      veil.style.display = 'none';
      spotlight.style.display = 'block';
      for (const b of blocks) b.style.display = 'block';
      spotlight.classList.toggle('is-clickable', isClick);
      holeCover.style.display = isClick ? 'none' : 'block';
      if (isClick) {
        const el = curEl;
        targetClickHandler = () => { void goTo(index + 1); };
        el.addEventListener('click', targetClickHandler, { once: true });
      }
    } else {
      veil.style.display = 'block';
      spotlight.style.display = 'none';
      spotlight.classList.remove('is-clickable');
      for (const b of blocks) b.style.display = 'none';
      holeCover.style.display = 'none';
    }

    layout();

    // Enable enter-fade + move transitions after the first placement is committed,
    // so step 0 fades in place and later steps glide between targets.
    const rr = root;
    if (!rr.classList.contains('is-shown')) {
      requestAnimationFrame(() => { if (active && rr === root) rr.classList.add('is-shown', 'is-anim'); });
    }

    if (!isClick) { try { nextBtn.focus({ preventScroll: true }); } catch { /* focus best-effort */ } }
    startSettle();
  }

  function startSettle(): void {
    // Re-measure for ~600ms to stay glued while screen-entry animations settle.
    settleUntil = performance.now() + 600;
    if (settleRaf) return;
    const loop = (): void => {
      if (!active) { settleRaf = 0; return; }
      layout();
      settleRaf = performance.now() < settleUntil ? requestAnimationFrame(loop) : 0;
    };
    settleRaf = requestAnimationFrame(loop);
  }

  function layout(): void {
    if (!active || !root) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;

    let rect: Box | null = null;
    if (curEl) {
      const r = curEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const left = clamp(r.left - pad, 0, vw);
        const top = clamp(r.top - pad, 0, vh);
        rect = {
          left,
          top,
          width: clamp(r.width + pad * 2, 0, vw - left),
          height: clamp(r.height + pad * 2, 0, vh - top),
        };
      }
    }

    if (rect) {
      setBox(spotlight, rect.left, rect.top, rect.width, rect.height);
      setBox(holeCover, rect.left, rect.top, rect.width, rect.height);
      const [t, b, l, rt] = blocks;
      const holeRight = rect.left + rect.width;
      const holeBottom = rect.top + rect.height;
      setBox(t, 0, 0, vw, rect.top);
      setBox(b, 0, holeBottom, vw, Math.max(0, vh - holeBottom));
      setBox(l, 0, rect.top, rect.left, rect.height);
      setBox(rt, holeRight, rect.top, Math.max(0, vw - holeRight), rect.height);
    }

    positionCard(rect, curStep?.placement ?? 'auto', vw, vh);
  }

  function setBox(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  }

  function pickSide(rect: Box, cw: number, ch: number, gap: number, margin: number, vw: number, vh: number): string {
    const below = vh - (rect.top + rect.height);
    const above = rect.top;
    const right = vw - (rect.left + rect.width);
    const left = rect.left;
    if (below >= ch + gap + margin) return 'bottom';
    if (above >= ch + gap + margin) return 'top';
    if (right >= cw + gap + margin) return 'right';
    if (left >= cw + gap + margin) return 'left';
    return below >= above ? 'bottom' : 'top';
  }

  function positionCard(rect: Box | null, placement: string, vw: number, vh: number): void {
    const gap = 16;
    const margin = 12;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;

    let left: number;
    let top: number;
    let place = placement;

    if (!rect) {
      left = (vw - cw) / 2;
      top = (vh - ch) / 2;
      place = 'center';
    } else {
      if (place === 'auto') place = pickSide(rect, cw, ch, gap, margin, vw, vh);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      switch (place) {
        case 'top': left = cx - cw / 2; top = rect.top - gap - ch; break;
        case 'left': left = rect.left - gap - cw; top = cy - ch / 2; break;
        case 'right': left = rect.left + rect.width + gap; top = cy - ch / 2; break;
        default: place = 'bottom'; left = cx - cw / 2; top = rect.top + rect.height + gap; break;
      }
    }

    left = clamp(left, margin, Math.max(margin, vw - cw - margin));
    top = clamp(top, margin, Math.max(margin, vh - ch - margin));
    card.style.left = left + 'px';
    card.style.top = top + 'px';

    positionArrow(place, rect, left, top, cw, ch);
  }

  function positionArrow(place: string, rect: Box | null, cardLeft: number, cardTop: number, cw: number, ch: number): void {
    if (!rect || place === 'center') { arrow.style.display = 'none'; return; }
    const size = 9;
    const bg = '#171e29';
    arrow.style.display = 'block';
    arrow.style.borderLeft = '';
    arrow.style.borderRight = '';
    arrow.style.borderTop = '';
    arrow.style.borderBottom = '';
    arrow.style.left = '';
    arrow.style.right = '';
    arrow.style.top = '';
    arrow.style.bottom = '';

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    if (place === 'bottom' || place === 'top') {
      arrow.style.left = clamp(cx - cardLeft - size, 14, cw - 14 - size) + 'px';
      arrow.style.borderLeft = size + 'px solid transparent';
      arrow.style.borderRight = size + 'px solid transparent';
      if (place === 'bottom') { arrow.style.top = -size + 'px'; arrow.style.borderBottom = size + 'px solid ' + bg; }
      else { arrow.style.bottom = -size + 'px'; arrow.style.borderTop = size + 'px solid ' + bg; }
    } else {
      arrow.style.top = clamp(cy - cardTop - size, 14, ch - 14 - size) + 'px';
      arrow.style.borderTop = size + 'px solid transparent';
      arrow.style.borderBottom = size + 'px solid transparent';
      if (place === 'right') { arrow.style.left = -size + 'px'; arrow.style.borderRight = size + 'px solid ' + bg; }
      else { arrow.style.right = -size + 'px'; arrow.style.borderLeft = size + 'px solid ' + bg; }
    }
  }

  function teardown(): void {
    active = false;
    stepToken++;
    clearStepScope();
    if (settleRaf) { cancelAnimationFrame(settleRaf); settleRaf = 0; }
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey, true);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    curEl = null;
    curStep = null;
  }

  function finish(): void {
    if (!active) return;
    const done = resolveFinish;
    resolveFinish = null;
    teardown();
    if (done) done();
  }

  function start(newSteps: OnbStep[]): Promise<void> {
    if (active) stop();
    steps = newSteps.slice();
    index = 0;
    if (steps.length === 0) return Promise.resolve();
    active = true;
    build();
    return new Promise<void>((resolve) => {
      resolveFinish = resolve;
      void goTo(0);
    });
  }

  function stop(): void { finish(); }

  return { start, stop, isActive: () => active };
}
