/**
 * Mode-select screen — sits between the title menu and the strategy/lobby.
 * Two-level: pick SINGLE PLAYER or MULTIPLAYER, then a specific mode. Styling
 * lives in screens.css (.mode-* classes).
 */
export type SingleMode = 'timetrial' | 'optimal' | 'overtake';
export type GameMode = SingleMode | 'multiplayer';
export type MpKind = 'find' | 'friends';

export interface ModeSelectHandle {
  root: HTMLElement;
  show(): void;
  hide(): void;
  onSingle(cb: (mode: SingleMode) => void): void;
  onMultiplayer(cb: (kind: MpKind) => void): void;
  /** back from the TOP level → title menu */
  onBack(cb: () => void): void;
}

interface Card { key: string; icon: string; title: string; tag: string; body: string }

const TOP: Card[] = [
  { key: 'single', icon: '🏁', title: 'Single Player', tag: 'SOLO · PRACTICE', body: 'Time-trial your best lap, watch the AI-optimal lap, or hunt down a rival. Three ways to master energy deployment.' },
  { key: 'multi', icon: '⚡', title: 'Multiplayer', tag: '2–4 PLAYERS', body: 'Race real people using only energy strategy. Find a match against anyone searching now, or open a private room for friends.' },
];

const SINGLE: Card[] = [
  { key: 'timetrial', icon: '⏱', title: 'Time Trial', tag: 'SOLO · HOT LAP', body: 'Chase the perfect lap. Spend energy in the right places, race your own ghost, and keep retrying to beat your best.' },
  { key: 'optimal', icon: '◎', title: 'Optimal Lap', tag: 'SOLVE & WATCH', body: 'Let the sim solve the fastest deployment strategy, then watch it drive the perfect lap. Learn from it.' },
  { key: 'overtake', icon: '⚔', title: 'Overtake Challenge', tag: '3 LAPS · PASS & HOLD', body: 'Start behind a strong rival. Get within 1.0 s to unlock Manual Override — extra power and +0.5 MJ — then pass and hold.' },
];

const MULTI: Card[] = [
  { key: 'find', icon: '🌐', title: 'Find a Match', tag: 'QUICK MATCH', body: 'Get matched against anyone else searching right now. Jump straight into a race — no code needed.' },
  { key: 'friends', icon: '🔑', title: 'Play with Friends', tag: 'ROOM CODE', body: 'Create a room and share the 5-character code, or join a friend’s. 2–4 players, private.' },
];

function cardHtml(c: Card): string {
  return `
    <button class="mode-card" data-key="${c.key}">
      <div class="mode-card-icon">${c.icon}</div>
      <div class="mode-card-tag">${c.tag}</div>
      <div class="mode-card-title">${c.title}</div>
      <div class="mode-card-body">${c.body}</div>
      <div class="mode-card-go">SELECT →</div>
    </button>`;
}

export function createModeSelect(container: HTMLElement): ModeSelectHandle {
  const root = document.createElement('div');
  root.className = 'screen mode-screen';
  root.style.display = 'none';
  root.innerHTML = `
    <div class="mode-inner">
      <div class="mode-head">
        <button class="mode-back"></button>
        <div class="mode-title"></div>
        <div class="mode-spacer"></div>
      </div>
      <div class="mode-grid" data-view="top">${TOP.map(cardHtml).join('')}</div>
      <div class="mode-grid" data-view="single" style="display:none">${SINGLE.map(cardHtml).join('')}</div>
      <div class="mode-grid" data-view="multi" style="display:none">${MULTI.map(cardHtml).join('')}</div>
    </div>`;
  container.appendChild(root);

  let singleCb: ((m: SingleMode) => void) | null = null;
  let mpCb: ((k: MpKind) => void) | null = null;
  let backCb: (() => void) | null = null;
  let view: 'top' | 'single' | 'multi' = 'top';

  const grids = {
    top: root.querySelector<HTMLElement>('[data-view="top"]')!,
    single: root.querySelector<HTMLElement>('[data-view="single"]')!,
    multi: root.querySelector<HTMLElement>('[data-view="multi"]')!,
  };
  const titleEl = root.querySelector<HTMLElement>('.mode-title')!;
  const backEl = root.querySelector<HTMLButtonElement>('.mode-back')!;

  function render(): void {
    for (const k of ['top', 'single', 'multi'] as const) grids[k].style.display = view === k ? 'grid' : 'none';
    titleEl.textContent = view === 'single' ? 'SINGLE PLAYER' : view === 'multi' ? 'MULTIPLAYER' : 'CHOOSE A MODE';
    backEl.textContent = view === 'top' ? '← Menu' : '← Back';
  }

  grids.top.querySelectorAll<HTMLElement>('.mode-card').forEach((btn) => {
    btn.addEventListener('click', () => { view = btn.dataset.key === 'multi' ? 'multi' : 'single'; render(); });
  });
  grids.single.querySelectorAll<HTMLElement>('.mode-card').forEach((btn) => {
    btn.addEventListener('click', () => singleCb?.(btn.dataset.key as SingleMode));
  });
  grids.multi.querySelectorAll<HTMLElement>('.mode-card').forEach((btn) => {
    btn.addEventListener('click', () => mpCb?.(btn.dataset.key as MpKind));
  });
  backEl.addEventListener('click', () => {
    if (view === 'top') backCb?.();
    else { view = 'top'; render(); }
  });

  return {
    root,
    show(): void { view = 'top'; render(); root.style.display = 'flex'; },
    hide(): void { root.style.display = 'none'; },
    onSingle(cb): void { singleCb = cb; },
    onMultiplayer(cb): void { mpCb = cb; },
    onBack(cb): void { backCb = cb; },
  };
}
