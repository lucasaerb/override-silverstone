/**
 * Multiplayer LOBBY screen for "OVERRIDE: Silverstone" head-to-head play.
 *
 * The room-code connection UI: create a room → share a code → opponent joins →
 * both ready up → race. This module owns ONLY the view. The lead wires the
 * WebRTC room (trystero) and the game flow to the events fired below and drives
 * the visible state through the setter API.
 *
 * Self-contained: injects its own CSS via an id-guarded <style> (added once,
 * shared across instances). It reuses the shared design tokens from screens.css
 * (--papaya / --teal / --glass-2 / --hair …) with inline fallbacks, and the
 * shared .btn / .btn-primary classes. Nothing here edits screens.css / hud.css.
 *
 * Phases (setPhase switches the visible section):
 *   choose    – Create room  OR  enter a code + Join.
 *   hosting   – Big copyable room code, "waiting for opponent", cancel.
 *   joining   – "Connecting to CODE…", cancel.
 *   connected – You / Opponent ready rows; Ready; host Start (or guest wait); Leave.
 */

export type LobbyPhase = 'choose' | 'hosting' | 'joining' | 'connected';

export interface LobbyHandle {
  root: HTMLElement;
  show(): void;
  hide(): void;
  // events fired to the lead:
  onCreate(cb: () => void): void; // user clicked "Create room"
  onJoin(cb: (code: string) => void): void; // user entered a code and clicked "Join"
  onReady(cb: () => void): void; // user clicked "Ready"
  onStart(cb: () => void): void; // HOST clicked "Start race" (both ready)
  onLeave(cb: () => void): void; // user clicked back / leave
  // state driven BY the lead:
  setPhase(p: LobbyPhase): void;
  setCode(code: string): void; // the room code to display (host) or echo (guest)
  setStatus(text: string): void; // e.g. "Waiting for opponent…", "Connected!"
  setRole(role: 'host' | 'guest'): void;
  setReady(you: boolean, them: boolean): void; // ready indicators
}

const STYLE_ID = 'f1-lobby-style';
const CODE_LEN = 5;
const JOIN_MIN = 4; // JOIN stays disabled until at least this many chars

export function createLobby(container: HTMLElement): LobbyHandle {
  injectStyle();

  const root = document.createElement('div');
  root.className = 'screen lobby-screen';
  root.style.display = 'none';
  root.innerHTML = `
    <div class="lobby-card">
      <div class="lobby-kicker">2 PLAYERS · ROOM CODE</div>

      <section class="lobby-section" data-phase="choose">
        <h2 class="lobby-heading">HEAD-TO-HEAD</h2>
        <p class="lobby-blurb">Race a friend on any device — no account, no server. Same car; the better energy strategist wins.</p>
        <button type="button" class="btn btn-primary lobby-create">CREATE ROOM</button>
        <div class="lobby-or"><span>OR JOIN WITH A CODE</span></div>
        <div class="lobby-join-row">
          <input class="lobby-code-input" type="text" inputmode="latin" autocomplete="off"
                 autocapitalize="characters" spellcheck="false" maxlength="${CODE_LEN}"
                 placeholder="ABC42" aria-label="Room code" />
          <button type="button" class="btn lobby-join" disabled>JOIN</button>
        </div>
        <button type="button" class="lobby-link lobby-leave">← Back</button>
      </section>

      <section class="lobby-section" data-phase="hosting">
        <h2 class="lobby-heading">ROOM CREATED</h2>
        <p class="lobby-subline">Share this code with a friend</p>
        <button type="button" class="lobby-code-display" title="Click to copy">
          <span class="lobby-code-text">·····</span>
          <span class="lobby-copy-hint">⧉ click to copy</span>
          <span class="lobby-copied-toast">Copied!</span>
        </button>
        <div class="lobby-wait">
          <span class="lobby-spinner"></span>
          <span class="lobby-status">Waiting for opponent…</span>
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
        <div class="lobby-ready-rows">
          <div class="lobby-ready-row" data-who="you">
            <span class="lobby-dot"></span>
            <span class="lobby-ready-name">You</span>
            <span class="lobby-ready-state">Not ready</span>
          </div>
          <div class="lobby-ready-row" data-who="them">
            <span class="lobby-dot"></span>
            <span class="lobby-ready-name">Opponent</span>
            <span class="lobby-ready-state">Not ready</span>
          </div>
        </div>
        <button type="button" class="btn btn-primary lobby-ready">READY</button>
        <button type="button" class="btn btn-primary lobby-start" disabled>START RACE</button>
        <p class="lobby-waiting-host" hidden>Waiting for host to start…</p>
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
  const createBtn = q<HTMLButtonElement>('.lobby-create');
  const codeInput = q<HTMLInputElement>('.lobby-code-input');
  const joinBtn = q<HTMLButtonElement>('.lobby-join');
  const codeDisplay = q<HTMLButtonElement>('.lobby-code-display');
  const codeText = q('.lobby-code-text');
  const copiedToast = q('.lobby-copied-toast');
  const joiningCode = q('.lobby-joining-code');
  const readyBtn = q<HTMLButtonElement>('.lobby-ready');
  const startBtn = q<HTMLButtonElement>('.lobby-start');
  const waitingHost = q<HTMLElement>('.lobby-waiting-host');
  const youRow = q<HTMLElement>('.lobby-ready-row[data-who="you"]');
  const themRow = q<HTMLElement>('.lobby-ready-row[data-who="them"]');

  // ---- callbacks -------------------------------------------------------
  let createCb: (() => void) | null = null;
  let joinCb: ((code: string) => void) | null = null;
  let readyCb: (() => void) | null = null;
  let startCb: (() => void) | null = null;
  let leaveCb: (() => void) | null = null;

  // ---- state -----------------------------------------------------------
  const state = {
    phase: 'choose' as LobbyPhase,
    code: '',
    role: 'host' as 'host' | 'guest',
    youReady: false,
    themReady: false,
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

  function renderReadyRow(row: HTMLElement, ready: boolean): void {
    row.classList.toggle('is-ready', ready);
    const stateEl = row.querySelector('.lobby-ready-state');
    if (stateEl) stateEl.textContent = ready ? 'Ready' : 'Not ready';
  }

  // Reconcile the connected-phase controls with role + both ready-flags.
  function refreshConnectedControls(): void {
    renderReadyRow(youRow, state.youReady);
    renderReadyRow(themRow, state.themReady);

    readyBtn.disabled = state.youReady;
    readyBtn.textContent = state.youReady ? "YOU'RE READY" : 'READY';

    const bothReady = state.youReady && state.themReady;
    const isHost = state.role === 'host';

    // Host drives the start; guest waits for the host once both are ready.
    startBtn.hidden = !isHost;
    startBtn.disabled = !bothReady;
    waitingHost.hidden = isHost || !bothReady;
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

  readyBtn.addEventListener('click', () => {
    if (state.youReady) return;
    state.youReady = true; // optimistic; the lead confirms via setReady
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
  refreshConnectedControls();
  applyPhase('choose');

  function applyPhase(p: LobbyPhase): void {
    state.phase = p;
    sections.forEach((el, phase) => el.classList.toggle('is-active', phase === p));
    if (p === 'choose') {
      codeInput.value = '';
      refreshJoinEnabled();
    }
    if (p === 'connected') refreshConnectedControls();
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
    setReady(you, them): void {
      state.youReady = you;
      state.themReady = them;
      refreshConnectedControls();
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
  width: min(460px, 92vw);
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
.lobby-blurb { font-size: 14px; line-height: 1.55; color: #cdd6e0; margin: -4px 0 2px; }

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

/* connected: ready rows */
.lobby-ready-rows { display: flex; flex-direction: column; gap: 8px; margin: 2px 0; }
.lobby-ready-row {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 15px; text-align: left;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--hair, rgba(255, 255, 255, 0.14));
  border-radius: 11px;
  transition: border-color 0.16s, background 0.16s;
}
.lobby-ready-row.is-ready { border-color: rgba(61, 220, 132, 0.5); background: rgba(61, 220, 132, 0.08); }
.lobby-dot {
  flex: 0 0 auto; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid var(--ink-dim, #9aa6b4); background: transparent;
  transition: background 0.16s, border-color 0.16s, box-shadow 0.16s;
}
.lobby-ready-row.is-ready .lobby-dot {
  background: #3ddc84; border-color: #3ddc84;
  box-shadow: 0 0 10px rgba(61, 220, 132, 0.7);
}
.lobby-ready-name { flex: 1; font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.lobby-ready-state {
  font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-dim, #9aa6b4);
}
.lobby-ready-row.is-ready .lobby-ready-state { color: #3ddc84; }

.lobby-ready { font-size: 15px; padding: 13px; letter-spacing: 0.1em; }
.lobby-ready:disabled {
  opacity: 1; cursor: default; color: #06130b;
  background: linear-gradient(180deg, #47e08a, #22b46e);
  border-color: rgba(61, 220, 132, 0.6);
}
.lobby-start { font-size: 15px; padding: 13px; letter-spacing: 0.1em; }
.lobby-start:disabled { opacity: 0.42; cursor: default; }
.lobby-start:disabled:hover { background: linear-gradient(180deg, #ff9a34, var(--papaya, #ff8412)); }
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
