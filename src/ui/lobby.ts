/**
 * Multiplayer LOBBY screen for "OVERRIDE: Silverstone" head-to-head play.
 *
 * The room-code connection UI: pick a name → create a room → share a code →
 * up to three friends join → everyone readies up → the host picks a lap count
 * and starts. This module owns ONLY the view. The lead wires the WebRTC room
 * (trystero) and the game flow to the events fired below and drives the visible
 * state through the setter API — `setRoster` is the single source of truth for
 * the slot rows, ready dots and START enablement.
 *
 * Self-contained: injects its own CSS via an id-guarded <style> (added once,
 * shared across instances). It reuses the shared design tokens from screens.css
 * (--papaya / --teal / --glass-2 / --hair …) with inline fallbacks, and the
 * shared .btn / .btn-primary classes. Nothing here edits screens.css / hud.css.
 *
 * Phases (setPhase switches the visible section):
 *   choose    – Your name + Create room  OR  enter a code + Join.
 *   hosting   – Big copyable room code + the roster (host waiting for friends).
 *   joining   – "Connecting to CODE…", cancel.
 *   connected – Roster (up to 4) + ready dots + lap selector + Ready + (host)
 *               Start / (guest) waiting-for-host. Leave.
 */

export type LobbyPhase = 'choose' | 'hosting' | 'joining' | 'connected';

export interface LobbyPlayer {
  name: string;
  color: string;
  ready: boolean;
  you: boolean;
  host: boolean;
}

export interface LobbyHandle {
  root: HTMLElement;
  show(): void;
  hide(): void;
  // events fired to the lead:
  onCreate(cb: () => void): void; // user clicked "Create room"
  onJoin(cb: (code: string) => void): void; // user entered a code and clicked "Join"
  onReady(cb: () => void): void; // user clicked "Ready"
  onStart(cb: () => void): void; // HOST clicked "Start race" (2+ players, all ready)
  onLeave(cb: () => void): void; // user clicked back / leave
  onName(cb: (name: string) => void): void; // local player's name field changed
  onLaps(cb: (laps: number) => void): void; // host changed the lap count
  // state driven BY the lead:
  setPhase(p: LobbyPhase): void;
  setCode(code: string): void; // the room code to display (host) or echo (guest)
  setStatus(text: string): void; // e.g. "Waiting for friends…", "Connected!"
  setRole(role: 'host' | 'guest'): void;
  setRoster(players: LobbyPlayer[]): void; // 1-4 entries; drives slots + ready + START
  setLaps(laps: number): void; // reflect the current lap count
  setLapsEditable(editable: boolean): void; // host can change laps; guests read-only
  getName(): string; // current value of the local name input
}

const STYLE_ID = 'f1-lobby-style';
const CODE_LEN = 5;
const JOIN_MIN = 4; // JOIN stays disabled until at least this many chars
const NAME_MAX = 14;
const LAP_OPTIONS = [2, 3, 5] as const;
const FALLBACK_COLOR = '#ff8412'; // papaya, if a roster entry omits a colour

export function createLobby(container: HTMLElement): LobbyHandle {
  injectStyle();

  const root = document.createElement('div');
  root.className = 'screen lobby-screen';
  root.style.display = 'none';
  root.innerHTML = `
    <div class="lobby-card">
      <div class="lobby-kicker">2–4 PLAYERS · ROOM CODE</div>

      <section class="lobby-section" data-phase="choose">
        <h2 class="lobby-heading">HEAD-TO-HEAD</h2>
        <p class="lobby-subline">2–4 players · race a friend</p>
        <label class="lobby-field">
          <span class="lobby-field-label">Your name</span>
          <input class="lobby-name-input" type="text" autocomplete="off"
                 spellcheck="false" maxlength="${NAME_MAX}"
                 value="Player" placeholder="Player" aria-label="Your name" />
        </label>
        <button type="button" class="btn btn-primary lobby-create">CREATE ROOM</button>
        <div class="lobby-or"><span>OR JOIN WITH A CODE</span></div>
        <div class="lobby-join-row">
          <input class="lobby-code-input" type="text" inputmode="latin" autocomplete="off"
                 autocapitalize="characters" spellcheck="false" maxlength="${CODE_LEN}"
                 placeholder="ABC42" aria-label="Room code" />
          <button type="button" class="btn lobby-join" disabled>JOIN</button>
        </div>
        <p class="lobby-blurb">Same car, same grip — the better energy strategist wins. No account, no server.</p>
        <button type="button" class="lobby-link lobby-leave">← Back</button>
      </section>

      <section class="lobby-section" data-phase="hosting">
        <h2 class="lobby-heading">ROOM CREATED</h2>
        <p class="lobby-subline">Share this code — up to 3 friends can join</p>
        <button type="button" class="lobby-code-display" title="Click to copy">
          <span class="lobby-code-text">·····</span>
          <span class="lobby-copy-hint">⧉ click to copy</span>
          <span class="lobby-copied-toast">Copied!</span>
        </button>
        <div class="lobby-slots" data-role="hosting"></div>
        <div class="lobby-wait">
          <span class="lobby-spinner"></span>
          <span class="lobby-status">Waiting for friends…</span>
        </div>
        <button type="button" class="btn lobby-leave">Cancel</button>
      </section>

      <section class="lobby-section" data-phase="joining">
        <h2 class="lobby-heading">CONNECTING…</h2>
        <p class="lobby-subline">Connecting to <span class="lobby-joining-code">·····</span></p>
        <div class="lobby-wait">
          <span class="lobby-spinner"></span>
          <span class="lobby-status">Reaching the room…</span>
        </div>
        <button type="button" class="btn lobby-leave">Cancel</button>
      </section>

      <section class="lobby-section" data-phase="connected">
        <h2 class="lobby-heading lobby-heading-ok">CONNECTED!</h2>
        <p class="lobby-subline lobby-status">Ready up to race.</p>
        <div class="lobby-slots" data-role="connected"></div>

        <div class="lobby-laps-wrap">
          <span class="lobby-laps-label">Race length</span>
          <div class="lobby-laps" role="group" aria-label="Lap count">
            ${LAP_OPTIONS.map(
              (n) =>
                `<button type="button" class="lobby-lap-seg" data-laps="${n}">${n}<span class="lobby-lap-unit">laps</span></button>`,
            ).join('')}
          </div>
          <span class="lobby-laps-lock" hidden>set by host</span>
        </div>

        <button type="button" class="btn btn-primary lobby-ready">READY</button>

        <div class="lobby-host-actions">
          <button type="button" class="btn btn-primary lobby-start" disabled>START RACE</button>
          <p class="lobby-start-hint"></p>
        </div>
        <p class="lobby-waiting-host" hidden>Waiting for the host to start…</p>

        <button type="button" class="btn lobby-leave">Leave</button>
      </section>
    </div>`;
  container.appendChild(root);

  // ---- element handles -------------------------------------------------
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const sections = new Map<LobbyPhase, HTMLElement>();
  root.querySelectorAll<HTMLElement>('.lobby-section').forEach((el) => {
    sections.set(el.dataset.phase as LobbyPhase, el);
  });
  const nameInput = q<HTMLInputElement>('.lobby-name-input');
  const createBtn = q<HTMLButtonElement>('.lobby-create');
  const codeInput = q<HTMLInputElement>('.lobby-code-input');
  const joinBtn = q<HTMLButtonElement>('.lobby-join');
  const codeDisplay = q<HTMLButtonElement>('.lobby-code-display');
  const codeText = q('.lobby-code-text');
  const copiedToast = q('.lobby-copied-toast');
  const joiningCode = q('.lobby-joining-code');
  const slotContainers = Array.from(root.querySelectorAll<HTMLElement>('.lobby-slots'));
  const lapsGroup = q<HTMLElement>('.lobby-laps');
  const lapSegs = Array.from(lapsGroup.querySelectorAll<HTMLButtonElement>('.lobby-lap-seg'));
  const lapsLock = q<HTMLElement>('.lobby-laps-lock');
  const readyBtn = q<HTMLButtonElement>('.lobby-ready');
  const hostActions = q<HTMLElement>('.lobby-host-actions');
  const startBtn = q<HTMLButtonElement>('.lobby-start');
  const startHint = q<HTMLElement>('.lobby-start-hint');
  const waitingHost = q<HTMLElement>('.lobby-waiting-host');

  // ---- callbacks -------------------------------------------------------
  let createCb: (() => void) | null = null;
  let joinCb: ((code: string) => void) | null = null;
  let readyCb: (() => void) | null = null;
  let startCb: (() => void) | null = null;
  let leaveCb: (() => void) | null = null;
  let nameCb: ((name: string) => void) | null = null;
  let lapsCb: ((laps: number) => void) | null = null;

  // ---- state -----------------------------------------------------------
  const state = {
    phase: 'choose' as LobbyPhase,
    code: '',
    role: 'host' as 'host' | 'guest',
    roster: [] as LobbyPlayer[],
    laps: LAP_OPTIONS[1] as number, // default 3
    lapsEditable: true,
  };
  let copiedTimer = 0;

  // ---- helpers ---------------------------------------------------------
  const sanitizeCode = (raw: string) =>
    raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);

  function refreshJoinEnabled(): void {
    joinBtn.disabled = codeInput.value.length < JOIN_MIN;
  }

  function renderCode(): void {
    const shown = state.code || '·····';
    codeText.textContent = shown;
    joiningCode.textContent = shown;
  }

  function buildSlot(p: LobbyPlayer, idx: number): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'lobby-slot' + (p.ready ? ' is-ready' : '');
    slot.dataset.idx = String(idx);

    const swatch = document.createElement('span');
    swatch.className = 'lobby-swatch';
    swatch.style.background = p.color || FALLBACK_COLOR;
    slot.appendChild(swatch);

    const nameWrap = document.createElement('span');
    nameWrap.className = 'lobby-slot-name';
    const nameText = document.createElement('span');
    nameText.className = 'lobby-slot-name-text';
    nameText.textContent = p.name || 'Player';
    nameWrap.appendChild(nameText);
    if (p.you) {
      const you = document.createElement('span');
      you.className = 'lobby-you-tag';
      you.textContent = '(you)';
      nameWrap.appendChild(you);
    }
    if (p.host) {
      const chip = document.createElement('span');
      chip.className = 'lobby-host-chip';
      chip.textContent = 'HOST';
      nameWrap.appendChild(chip);
    }
    slot.appendChild(nameWrap);

    const ind = document.createElement('span');
    ind.className = 'lobby-ready-ind' + (p.ready ? ' is-ready' : '');
    ind.textContent = p.ready ? '●' : '○';
    ind.setAttribute('aria-label', p.ready ? 'ready' : 'not ready');
    slot.appendChild(ind);

    return slot;
  }

  function renderRoster(): void {
    slotContainers.forEach((container) => {
      container.textContent = '';
      state.roster.forEach((p, i) => container.appendChild(buildSlot(p, i)));
    });
  }

  function renderLaps(): void {
    lapSegs.forEach((seg) => {
      const n = Number(seg.dataset.laps);
      seg.classList.toggle('is-active', n === state.laps);
      seg.disabled = !state.lapsEditable;
    });
    lapsGroup.classList.toggle('is-readonly', !state.lapsEditable);
    lapsLock.hidden = state.lapsEditable;
  }

  // Reconcile the connected-phase controls with role + roster.
  function refreshConnectedControls(): void {
    const me = state.roster.find((p) => p.you) ?? null;
    const iAmReady = !!me?.ready;
    const isHost = state.role === 'host';

    readyBtn.disabled = iAmReady;
    readyBtn.textContent = iAmReady ? "YOU'RE READY" : 'READY';

    const enoughPlayers = state.roster.length >= 2;
    const allReady = enoughPlayers && state.roster.every((p) => p.ready);
    const canStart = enoughPlayers && allReady;

    // Host drives the start; guests wait for the host once they're ready.
    hostActions.hidden = !isHost;
    startBtn.disabled = !canStart;
    startHint.hidden = !isHost || canStart;
    startHint.textContent = !enoughPlayers
      ? 'need 2+ players'
      : 'waiting for players to ready up';

    waitingHost.hidden = isHost || !iAmReady;
  }

  function applyRoster(players: LobbyPlayer[]): void {
    state.roster = players.slice(0, 4);
    renderRoster();
    refreshConnectedControls();
  }

  function showCopied(): void {
    copiedToast.classList.add('show');
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => copiedToast.classList.remove('show'), 1200);
  }

  async function copyCode(): Promise<void> {
    if (!state.code) return;
    try {
      await navigator.clipboard.writeText(state.code);
    } catch {
      // Fallback for insecure contexts / older browsers.
      const ta = document.createElement('textarea');
      ta.value = state.code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing more we can do */
      }
      document.body.removeChild(ta);
    }
    showCopied();
  }

  function triggerJoin(): void {
    if (joinBtn.disabled) return;
    joinCb?.(codeInput.value);
  }

  // ---- wiring ----------------------------------------------------------
  nameInput.addEventListener('input', () => {
    nameCb?.(nameInput.value);
  });

  createBtn.addEventListener('click', () => createCb?.());
  joinBtn.addEventListener('click', triggerJoin);
  codeDisplay.addEventListener('click', () => void copyCode());

  codeInput.addEventListener('input', () => {
    const clean = sanitizeCode(codeInput.value);
    if (clean !== codeInput.value) codeInput.value = clean;
    refreshJoinEnabled();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerJoin();
    }
  });

  lapSegs.forEach((seg) => {
    seg.addEventListener('click', () => {
      if (!state.lapsEditable) return;
      const n = Number(seg.dataset.laps);
      if (!Number.isFinite(n) || n === state.laps) return;
      state.laps = n;
      renderLaps();
      lapsCb?.(n);
    });
  });

  readyBtn.addEventListener('click', () => {
    if (readyBtn.disabled) return;
    // Optimistic: flip my own ready flag; reconciled by the next setRoster.
    const me = state.roster.find((p) => p.you);
    if (me) me.ready = true;
    renderRoster();
    refreshConnectedControls();
    readyCb?.();
  });
  startBtn.addEventListener('click', () => {
    if (!startBtn.disabled) startCb?.();
  });
  root.querySelectorAll<HTMLElement>('.lobby-leave').forEach((el) => {
    el.addEventListener('click', () => leaveCb?.());
  });

  // ---- initial paint ---------------------------------------------------
  renderCode();
  renderLaps();
  refreshConnectedControls();
  applyPhase('choose');

  function applyPhase(p: LobbyPhase): void {
    state.phase = p;
    sections.forEach((el, phase) => el.classList.toggle('is-active', phase === p));
    if (p === 'choose') {
      codeInput.value = '';
      refreshJoinEnabled();
    }
    if (p === 'connected' || p === 'hosting') {
      renderRoster();
      refreshConnectedControls();
    }
  }

  // ---- public API ------------------------------------------------------
  return {
    root,
    show(): void {
      root.style.display = 'flex';
    },
    hide(): void {
      root.style.display = 'none';
    },
    onCreate(cb): void {
      createCb = cb;
    },
    onJoin(cb): void {
      joinCb = cb;
    },
    onReady(cb): void {
      readyCb = cb;
    },
    onStart(cb): void {
      startCb = cb;
    },
    onLeave(cb): void {
      leaveCb = cb;
    },
    onName(cb): void {
      nameCb = cb;
    },
    onLaps(cb): void {
      lapsCb = cb;
    },
    setPhase(p): void {
      applyPhase(p);
    },
    setCode(code): void {
      state.code = sanitizeCode(code);
      renderCode();
    },
    setStatus(text): void {
      root.querySelectorAll('.lobby-status').forEach((el) => {
        el.textContent = text;
      });
    },
    setRole(role): void {
      state.role = role;
      refreshConnectedControls();
    },
    setRoster(players): void {
      applyRoster(players);
    },
    setLaps(laps): void {
      state.laps = laps;
      renderLaps();
    },
    setLapsEditable(editable): void {
      state.lapsEditable = editable;
      renderLaps();
    },
    getName(): string {
      return nameInput.value.trim() || 'Player';
    },
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
.lobby-screen {
  align-items: center;
  justify-content: center;
  z-index: 22;
  background: radial-gradient(120% 90% at 50% 16%, rgba(6, 10, 16, 0.42), rgba(6, 10, 16, 0.86));
  font-family: var(--ui-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  color: var(--ink, #e8eef5);
}
.lobby-card {
  position: relative;
  box-sizing: border-box;
  width: min(480px, 92vw);
  background: var(--glass-2, rgba(22, 29, 40, 0.9));
  border: 1px solid var(--hair, rgba(255, 255, 255, 0.14));
  border-radius: 18px;
  padding: 30px 30px 26px;
  backdrop-filter: blur(12px);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
  text-align: center;
}
.lobby-kicker {
  font-size: 11px;
  letter-spacing: 0.4em;
  color: var(--papaya, #ff8412);
  font-weight: 700;
  margin-bottom: 4px;
}

/* one section per phase; only the active one is laid out */
.lobby-section { display: none; flex-direction: column; align-items: stretch; gap: 16px; }
.lobby-section.is-active { display: flex; }

.lobby-heading {
  font-size: 30px;
  font-weight: 900;
  letter-spacing: 0.05em;
  margin: 2px 0 0;
  line-height: 1;
  text-shadow: 0 6px 30px rgba(255, 132, 18, 0.28);
}
.lobby-heading-ok { color: #3ddc84; text-shadow: 0 6px 30px rgba(61, 220, 132, 0.3); }
.lobby-subline { font-size: 13px; color: var(--ink-dim, #9aa6b4); margin: -8px 0 0; letter-spacing: 0.02em; }
.lobby-blurb { font-size: 13px; line-height: 1.5; color: #cdd6e0; margin: -2px 0 2px; }

/* name field */
.lobby-field { display: flex; flex-direction: column; gap: 6px; text-align: left; }
.lobby-field-label {
  font-size: 10px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--ink-dim, #9aa6b4);
}
.lobby-name-input {
  width: 100%; box-sizing: border-box;
  font-family: inherit; font-size: 16px; font-weight: 650; letter-spacing: 0.01em;
  color: var(--ink, #e8eef5);
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid var(--hair, rgba(255, 255, 255, 0.14));
  border-radius: 10px; padding: 11px 13px;
  transition: border-color 0.14s, box-shadow 0.14s;
}
.lobby-name-input::placeholder { color: rgba(154, 166, 180, 0.5); }
.lobby-name-input:focus {
  outline: none;
  border-color: var(--papaya, #ff8412);
  box-shadow: 0 0 0 3px rgba(255, 132, 18, 0.18);
}

.lobby-create { font-size: 16px; padding: 14px; letter-spacing: 0.1em; }

/* OR divider */
.lobby-or { display: flex; align-items: center; gap: 12px; margin: -2px 0; }
.lobby-or::before, .lobby-or::after {
  content: ''; flex: 1; height: 1px; background: var(--hair, rgba(255, 255, 255, 0.14));
}
.lobby-or span { font-size: 10px; letter-spacing: 0.18em; color: var(--ink-dim, #9aa6b4); font-weight: 700; }

/* code input + JOIN */
.lobby-join-row { display: flex; gap: 8px; }
.lobby-code-input {
  flex: 1; min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", monospace;
  font-size: 22px; font-weight: 700;
  letter-spacing: 0.28em; text-indent: 0.28em; text-align: center;
  text-transform: uppercase; font-variant-numeric: tabular-nums;
  color: var(--ink, #e8eef5);
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid var(--hair, rgba(255, 255, 255, 0.14));
  border-radius: 10px; padding: 11px 10px;
  transition: border-color 0.14s, box-shadow 0.14s;
}
.lobby-code-input::placeholder { color: rgba(154, 166, 180, 0.5); letter-spacing: 0.28em; }
.lobby-code-input:focus {
  outline: none;
  border-color: var(--papaya, #ff8412);
  box-shadow: 0 0 0 3px rgba(255, 132, 18, 0.18);
}
.lobby-join { flex: 0 0 auto; padding: 11px 22px; font-size: 14px; }
.lobby-join:disabled { opacity: 0.4; cursor: default; }
.lobby-join:disabled:hover { background: rgba(255, 255, 255, 0.06); border-color: var(--hair, rgba(255, 255, 255, 0.14)); }

/* text-link back */
.lobby-link {
  align-self: center; margin-top: 2px;
  font-family: inherit; font-size: 13px; font-weight: 600;
  color: var(--ink-dim, #9aa6b4); background: none; border: none; cursor: pointer;
  padding: 4px 8px; border-radius: 7px; transition: color 0.14s;
}
.lobby-link:hover { color: var(--ink, #e8eef5); }

/* big copyable room code */
.lobby-code-display {
  position: relative;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  width: 100%; cursor: pointer; font-family: inherit;
  padding: 22px 16px 16px;
  background: rgba(255, 132, 18, 0.08);
  border: 1px solid rgba(255, 132, 18, 0.38);
  border-radius: 14px;
  transition: background 0.14s, border-color 0.14s, transform 0.05s;
}
.lobby-code-display:hover { background: rgba(255, 132, 18, 0.14); border-color: rgba(255, 132, 18, 0.6); }
.lobby-code-display:active { transform: translateY(1px); }
.lobby-code-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", monospace;
  font-size: clamp(46px, 9vw, 62px);
  font-weight: 800;
  letter-spacing: 0.2em; text-indent: 0.2em;
  line-height: 1; color: var(--papaya, #ff8412);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 4px 26px rgba(255, 132, 18, 0.45);
}
.lobby-copy-hint { font-size: 10.5px; letter-spacing: 0.14em; color: var(--ink-dim, #9aa6b4); font-weight: 600; }
.lobby-copied-toast {
  position: absolute; top: 8px; right: 10px;
  font-size: 11px; font-weight: 800; letter-spacing: 0.06em;
  color: #06130b; background: #3ddc84; border-radius: 6px; padding: 3px 8px;
  opacity: 0; transform: translateY(-4px); pointer-events: none;
  transition: opacity 0.16s, transform 0.16s;
}
.lobby-copied-toast.show { opacity: 1; transform: translateY(0); }

/* waiting row (spinner + status) */
.lobby-wait { display: flex; align-items: center; justify-content: center; gap: 10px; }
.lobby-status { font-size: 13px; color: var(--ink-dim, #9aa6b4); letter-spacing: 0.02em; }
.lobby-spinner {
  flex: 0 0 auto; width: 15px; height: 15px; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.16);
  border-top-color: var(--papaya, #ff8412);
  animation: lobby-spin 0.8s linear infinite;
}
@keyframes lobby-spin { to { transform: rotate(360deg); } }

/* roster slots (hosting + connected) */
.lobby-slots { display: flex; flex-direction: column; gap: 8px; }
.lobby-slot {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px; text-align: left;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--hair, rgba(255, 255, 255, 0.14));
  border-radius: 11px;
  transition: border-color 0.16s, background 0.16s;
}
.lobby-slot.is-ready { border-color: rgba(61, 220, 132, 0.5); background: rgba(61, 220, 132, 0.08); }
.lobby-swatch {
  flex: 0 0 auto; width: 16px; height: 16px; border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.35), inset 0 0 6px rgba(255, 255, 255, 0.15);
}
.lobby-slot-name {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px;
  font-size: 15px; font-weight: 700; letter-spacing: 0.01em;
}
.lobby-slot-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lobby-you-tag { flex: 0 0 auto; font-size: 11px; font-weight: 650; color: var(--ink-dim, #9aa6b4); letter-spacing: 0.02em; }
.lobby-host-chip {
  flex: 0 0 auto;
  font-size: 9px; font-weight: 800; letter-spacing: 0.12em;
  color: #1a1206; background: var(--papaya, #ff8412);
  border-radius: 5px; padding: 2px 6px;
}
.lobby-ready-ind {
  flex: 0 0 auto; font-size: 15px; line-height: 1;
  color: var(--ink-dim, #9aa6b4);
}
.lobby-ready-ind.is-ready { color: #3ddc84; text-shadow: 0 0 10px rgba(61, 220, 132, 0.75); }

/* lap selector */
.lobby-laps-wrap { display: flex; align-items: center; gap: 10px; }
.lobby-laps-label {
  flex: 0 0 auto; font-size: 10px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--ink-dim, #9aa6b4);
}
.lobby-laps { flex: 1; display: flex; gap: 6px; }
.lobby-lap-seg {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1px;
  font-family: inherit; font-size: 18px; font-weight: 800; font-variant-numeric: tabular-nums;
  color: var(--ink, #e8eef5);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--hair, rgba(255, 255, 255, 0.14));
  border-radius: 9px; padding: 8px 0 6px; cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.lobby-lap-seg .lobby-lap-unit {
  font-size: 8.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-dim, #9aa6b4);
}
.lobby-lap-seg:hover { background: rgba(255, 255, 255, 0.1); }
.lobby-lap-seg.is-active {
  color: #1a1206; background: var(--papaya, #ff8412); border-color: var(--papaya, #ff8412);
}
.lobby-lap-seg.is-active .lobby-lap-unit { color: rgba(26, 18, 6, 0.7); }
.lobby-laps.is-readonly .lobby-lap-seg { cursor: default; }
.lobby-laps.is-readonly .lobby-lap-seg:not(.is-active) { opacity: 0.4; }
.lobby-laps.is-readonly .lobby-lap-seg:hover:not(.is-active) { background: rgba(255, 255, 255, 0.04); }
.lobby-laps-lock { flex: 0 0 auto; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--ink-dim, #9aa6b4); font-style: italic; }

/* ready / start / waiting */
.lobby-ready { font-size: 15px; padding: 13px; letter-spacing: 0.1em; }
.lobby-ready:disabled {
  opacity: 1; cursor: default; color: #06130b;
  background: linear-gradient(180deg, #47e08a, #22b46e);
  border-color: rgba(61, 220, 132, 0.6);
}
.lobby-host-actions { display: flex; flex-direction: column; gap: 8px; }
.lobby-start { font-size: 15px; padding: 13px; letter-spacing: 0.1em; }
.lobby-start:disabled { opacity: 0.42; cursor: default; }
.lobby-start:disabled:hover { background: linear-gradient(180deg, #ff9a34, var(--papaya, #ff8412)); }
.lobby-start-hint {
  margin: 0; font-size: 11px; font-weight: 650; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--ink-dim, #9aa6b4); text-align: center;
}
.lobby-waiting-host {
  margin: 0; font-size: 13px; font-weight: 650; letter-spacing: 0.02em;
  color: var(--teal, #2ab6b0); display: flex; align-items: center; justify-content: center; gap: 8px;
}
.lobby-waiting-host::before {
  content: ''; width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid rgba(42, 182, 176, 0.3); border-top-color: var(--teal, #2ab6b0);
  animation: lobby-spin 0.8s linear infinite;
}
`;
