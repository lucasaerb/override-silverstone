/**
 * Title screen. Sits over the live 3D scene (main.ts runs a slow aerial orbit
 * of the circuit with both cars on the grid behind it). START advances to the
 * strategy screen.
 */
export interface MenuScreenHandle {
  root: HTMLElement;
  show(): void;
  hide(): void;
  onStart(cb: () => void): void;
}

export function createMenuScreen(container: HTMLElement): MenuScreenHandle {
  const root = document.createElement('div');
  root.className = 'screen menu-screen';
  root.innerHTML = `
    <div class="menu-inner">
      <div class="menu-kicker">FORMULA 1 · 2026 REGULATIONS</div>
      <h1 class="menu-title">OVERRIDE</h1>
      <div class="menu-sub">SILVERSTONE · ENERGY DEPLOYMENT DUEL</div>
      <p class="menu-blurb">
        Same car, same grip. The race is won on <b>energy</b>. You have one lap's
        worth to spend anywhere on track — pour it into the straights where passes
        happen, bank it where you're grip-limited. Get within <b>1.0 s</b> of the car
        ahead and unlock <b>Manual Override</b> to strike.
      </p>
      <button class="btn btn-primary menu-start">START</button>
      <div class="menu-regs">
        <span><b>8.0</b> MJ / lap harvest</span>
        <span><b>350</b> kW deploy · tapers past 290 km/h</span>
        <span><b>Override</b> holds full power to 337 km/h within 1.0 s</span>
      </div>
      <div class="menu-credit">© 2026 Lucas Erb · <a href="https://lucaserb.com" target="_blank" rel="noopener noreferrer">lucaserb.com</a></div>
    </div>`;
  container.appendChild(root);

  const startBtn = root.querySelector<HTMLButtonElement>('.menu-start');
  let startCb: (() => void) | null = null;
  startBtn?.addEventListener('click', () => startCb?.());

  return {
    root,
    show(): void { root.style.display = 'flex'; },
    hide(): void { root.style.display = 'none'; },
    onStart(cb): void { startCb = cb; },
  };
}
