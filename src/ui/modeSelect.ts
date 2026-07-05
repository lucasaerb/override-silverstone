/**
 * Mode-select screen — sits between the title menu and the strategy screen.
 * Four game modes, each a card. Styling lives in screens.css (.mode-* classes).
 */
export type GameMode = 'timetrial' | 'optimal' | 'overtake' | 'multiplayer';

export interface ModeSelectHandle {
  root: HTMLElement;
  show(): void;
  hide(): void;
  onSelect(cb: (mode: GameMode) => void): void;
  onBack(cb: () => void): void;
}

interface ModeCard {
  mode: GameMode;
  icon: string;
  title: string;
  tag: string;
  body: string;
}

const CARDS: ModeCard[] = [
  {
    mode: 'timetrial',
    icon: '⏱',
    title: 'Time Trial',
    tag: 'SOLO · HOT LAP',
    body: 'Chase the perfect lap. Spend your energy in the right places, race your own ghost, and keep retrying to beat your best.',
  },
  {
    mode: 'optimal',
    icon: '◎',
    title: 'Optimal Lap',
    tag: 'SOLVE & WATCH',
    body: 'Let the simulation solve the fastest deployment strategy for the track, then watch it drive the perfect lap. Learn from it.',
  },
  {
    mode: 'overtake',
    icon: '⚔',
    title: 'Overtake Challenge',
    tag: '3 LAPS · PASS & HOLD',
    body: 'Start behind a strong rival. Get within 1.0 s to unlock Manual Override — extra power and +0.5 MJ — then pass and hold the lead.',
  },
  {
    mode: 'multiplayer',
    icon: '⚡',
    title: 'Head-to-Head',
    tag: '2 PLAYERS · ROOM CODE',
    body: 'Race a friend with a share code — no server needed. Same car, same grip: the better energy strategist wins.',
  },
];

export function createModeSelect(container: HTMLElement): ModeSelectHandle {
  const root = document.createElement('div');
  root.className = 'screen mode-screen';
  root.style.display = 'none';
  root.innerHTML = `
    <div class="mode-inner">
      <div class="mode-head">
        <button class="mode-back">← Menu</button>
        <div class="mode-title">CHOOSE A MODE</div>
        <div class="mode-spacer"></div>
      </div>
      <div class="mode-grid">
        ${CARDS.map(
          (c) => `
          <button class="mode-card" data-mode="${c.mode}">
            <div class="mode-card-icon">${c.icon}</div>
            <div class="mode-card-tag">${c.tag}</div>
            <div class="mode-card-title">${c.title}</div>
            <div class="mode-card-body">${c.body}</div>
            <div class="mode-card-go">SELECT →</div>
          </button>`,
        ).join('')}
      </div>
    </div>`;
  container.appendChild(root);

  let selectCb: ((m: GameMode) => void) | null = null;
  let backCb: (() => void) | null = null;

  root.querySelectorAll<HTMLElement>('.mode-card').forEach((btn) => {
    btn.addEventListener('click', () => selectCb?.(btn.dataset.mode as GameMode));
  });
  root.querySelector('.mode-back')!.addEventListener('click', () => backCb?.());

  return {
    root,
    show(): void { root.style.display = 'flex'; },
    hide(): void { root.style.display = 'none'; },
    onSelect(cb): void { selectCb = cb; },
    onBack(cb): void { backCb = cb; },
  };
}
