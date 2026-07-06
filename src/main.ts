/**
 * OVERRIDE: Silverstone — game entry + flow orchestrator.
 *
 * Screens: menu → modeselect → strategy → race → result (+ a lobby screen for
 * multiplayer). The chosen `mode` drives how the race is configured and judged:
 *  - timetrial: solo hot-lap vs your own saved ghost; beat your best.
 *  - optimal:   solve the fastest map, then spectate the perfect lap.
 *  - overtake:  3 laps starting behind a strong (~optimal) rival — use the
 *               within-1-second Override edge to pass and hold.
 *  - multiplayer: room-code head-to-head (wired in workstream D).
 *
 * The 3D scene renders under every screen. The race runs on a fixed-timestep
 * accumulator; all test/authoring control goes through window.__game (debug.ts).
 */
import * as THREE from 'three';
import { loadTrack, trackAt, wrapS } from './sim/track';
import { racingLineFor, projectLap } from './sim/projection';
import { SIM } from './sim/constants';
import type { CarState, DeployMap, RaceState } from './sim/types';
import { RaceController, type RaceOptions } from './sim/race';
import { createScene, type SceneHandles } from './render/scene';
import { buildTrackMeshes } from './render/trackMesh';
import { buildEnvironment } from './render/environment';
import { CameraRig, type CameraMode } from './render/cameras';
import { createCarModel, type CarModelHandle } from './render/carModel';
import { createHud } from './ui/hud';
import { createTelemetry } from './ui/telemetry';
import { createMinimap } from './ui/minimap';
import { createBanners } from './ui/banners';
import { createMenuScreen } from './ui/menuScreen';
import { createModeSelect, type GameMode } from './ui/modeSelect';
import { createStrategyScreen, type RaceSetup } from './ui/strategyScreen';
import { createResultScreen, type RaceResult, type LapEnergy } from './ui/resultScreen';
import { TrackMap, cycleLevel } from './ui/trackMap';
import { createAudio } from './ui/audio';
import { createStartLights } from './ui/startLights';
import { createOnboarding, type OnbStep } from './ui/onboarding';
import { createLobby } from './ui/lobby';
import { joinRoom, makeRoomCode, type RoomHandle, type NetRole } from './net/room';
import { solveOptimal, analyzeZones } from './ui/solverClient';
import { getBestLap, saveBestLapIfBetter, hasSeenOnboarding, setSeenOnboarding, type GhostTrace } from './ui/records';
import { installDebugApi } from './debug';

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.error ?? e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

type Screen = 'menu' | 'modeselect' | 'strategy' | 'race' | 'result' | 'lobby';

const WHEELBASE = 3.4;
const BOOST_GLOW_W = 300e3;
const MAX_TICKS_PER_FRAME = 2400;
const LEAD_CONFIRM_S = 1.5;
const TIMETRIAL_LAPS = 3;
const OVERTAKE_LAPS = 3;
const OVERTAKE_START_BACK_M = 24; // ~1.2 s behind at racing speed
const GHOST_SAMPLE_S = 0.05;

function fmtLap(t: number): string {
  if (!Number.isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
}

interface NameLabel { sprite: THREE.Sprite; set(name: string, color: string): void }

/** A camera-facing name pill that floats above a car (multiplayer). */
function createNameLabel(): NameLabel {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(7, 1.75, 1);
  sprite.renderOrder = 999;
  let cur = '';
  return {
    sprite,
    set(name: string, color: string): void {
      const key = `${name}|${color}`;
      if (key === cur) return;
      cur = key;
      ctx.clearRect(0, 0, 256, 64);
      const r = 16;
      ctx.fillStyle = 'rgba(9,11,15,0.74)';
      ctx.beginPath();
      ctx.moveTo(6 + r, 16);
      ctx.arcTo(250, 16, 250, 48, r);
      ctx.arcTo(250, 48, 6, 48, r);
      ctx.arcTo(6, 48, 6, 16, r);
      ctx.arcTo(6, 16, 250, 16, r);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(28, 32, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f4f6f8';
      ctx.font = 'bold 26px system-ui, -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(name.slice(0, 12).toUpperCase(), 46, 34);
      tex.needsUpdate = true;
    },
  };
}

/** Weaken the optimal map so the overtake rival is strong-but-beatable: trim
 *  deploy in its two highest-value zones (leaves real time on the table exactly
 *  where a skilled player, with the Override edge, can take it). */
function challengeRivalMap(optimal: DeployMap, highValueZoneIds: number[]): DeployMap {
  const m: DeployMap = { zoneDeploy: [...optimal.zoneDeploy], zoneLift: [...optimal.zoneLift] };
  for (const id of highValueZoneIds.slice(0, 2)) {
    m.zoneDeploy[id] = Math.max(0, (m.zoneDeploy[id] ?? 0) - 0.5);
  }
  return m;
}

async function boot(): Promise<void> {
  const track = await loadTrack();
  const line = racingLineFor(track);
  const n = track.samples.length;

  const sampleLerp = (arr: ArrayLike<number>, s: number): number => {
    const sw = wrapS(track, s);
    const i0 = Math.min(Math.floor(sw / track.ds), n - 1);
    const f = sw / track.ds - i0;
    return arr[i0] + (arr[(i0 + 1) % n] - arr[i0]) * f;
  };

  // ---- 3D scene
  const container = document.getElementById('app');
  if (!container) throw new Error('missing #app container');
  const sceneCtx: SceneHandles = createScene(container);
  const { renderer, scene } = sceneCtx;
  scene.add(buildTrackMeshes(track).group);
  scene.add(buildEnvironment(track));

  // up to 4 cars (2-4 player multiplayer); the first two double as the
  // single-player player(papaya)/rival(teal) pair.
  const carModels: CarModelHandle[] = (['player', 'rival', 'car3', 'car4'] as const).map((livery) => createCarModel({ livery }));
  for (const m of carModels) scene.add(m.root);
  carModels[2].root.visible = false;
  carModels[3].root.visible = false;
  const models = { player: carModels[0], rival: carModels[1] };
  /** per-slot UI colours (match the car liveries) for labels / lobby / results */
  const SLOT_COLORS = ['#ff8412', '#19b8b0', '#e23b52', '#7c5cff'];
  const slotOf = (id: string): number => {
    if (id === 'player') return 0;
    if (id === 'rival') return 1;
    const n = parseInt(id.slice(1), 10);
    return Number.isFinite(n) ? n : 0;
  };
  // floating name labels above each car (multiplayer only)
  const carLabels = carModels.map(() => createNameLabel());
  for (const l of carLabels) { l.sprite.visible = false; scene.add(l.sprite); }

  // translucent ghost car (Time Trial) — hidden by default
  const ghostModel = createCarModel({ livery: 'player' });
  ghostModel.root.visible = false;
  ghostModel.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mt of mats) { (mt as THREE.Material).transparent = true; (mt as THREE.Material).opacity = 0.32; }
    }
  });
  scene.add(ghostModel.root);

  const rig = new CameraRig(track, container.clientWidth / Math.max(1, container.clientHeight));
  sceneCtx.registerCamera(rig.camera);

  // aerial orbit for non-race screens
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
  for (const s of track.samples) {
    bMinX = Math.min(bMinX, s.x); bMaxX = Math.max(bMaxX, s.x);
    bMinY = Math.min(bMinY, s.y); bMaxY = Math.max(bMaxY, s.y);
  }
  const ctr = new THREE.Vector3((bMinX + bMaxX) / 2, 0, -(bMinY + bMaxY) / 2);
  const orbitR = Math.max(bMaxX - bMinX, bMaxY - bMinY) * 0.62;
  let orbitAngle = 0;

  // ---- race UI
  const raceUi = document.createElement('div');
  raceUi.className = 'race-ui';
  container.appendChild(raceUi);
  const hud = createHud(raceUi);
  const telemetry = createTelemetry(raceUi);
  const minimap = createMinimap(raceUi, track);
  const banners = createBanners(raceUi);
  const audio = createAudio();

  // persistent controls bar along the bottom so keys are always discoverable
  const controlsBar = document.createElement('div');
  controlsBar.className = 'controls-bar';
  const controlKey = (k: string, label: string): string => `<span class="ctrl"><kbd>${k}</kbd>${label}</span>`;
  const setControls = (m: GameMode): void => {
    controlsBar.innerHTML =
      controlKey('SPACE', 'deploy') +
      controlKey('↑ ↓', 'trim') +
      controlKey('C', 'camera') +
      controlKey('T', 'telemetry') +
      (m === 'multiplayer' ? '' : controlKey('M', 'live map')) +
      controlKey('ESC', 'pause');
  };
  raceUi.appendChild(controlsBar);
  const startAudio = (): void => {
    audio.resume();
    window.removeEventListener('pointerdown', startAudio);
    window.removeEventListener('keydown', startAudio);
  };
  window.addEventListener('pointerdown', startAudio);
  window.addEventListener('keydown', startAudio);
  const startLights = createStartLights(container);
  const onboarding = createOnboarding(container);
  const lobby = createLobby(container);

  // matchmaking overlay (quick match)
  const mmOverlay = document.createElement('div');
  mmOverlay.className = 'mm-overlay';
  mmOverlay.style.display = 'none';
  mmOverlay.innerHTML = `
    <div class="mm-card">
      <div class="mm-kicker">QUICK MATCH</div>
      <div class="mm-title">FINDING A MATCH</div>
      <input class="mm-name" maxlength="14" placeholder="Your name" />
      <div class="mm-spinner"></div>
      <div class="mm-status">Searching for players…</div>
      <div class="mm-count">1 in the lobby</div>
      <button class="btn mm-cancel">Cancel</button>
    </div>`;
  container.appendChild(mmOverlay);
  const mmNameInput = mmOverlay.querySelector<HTMLInputElement>('.mm-name')!;
  mmNameInput.addEventListener('input', () => { myName = mmNameInput.value.trim() || 'Player'; if (netRole === 'host') { const e = roster.find((x) => x.peerId === net?.selfId); if (e) { e.name = myName; broadcastRoster(); } } else net?.send({ t: 'name', name: myName }); });
  mmOverlay.querySelector('.mm-cancel')!.addEventListener('click', () => { leaveMp(); setScreen('modeselect'); });

  // ---- screens
  const menu = createMenuScreen(container);
  const modeSelect = createModeSelect(container);
  let mode: GameMode = 'timetrial';
  let setup: RaceSetup = { playerMap: emptyMap(track), rivalSkill: 'balanced', laps: SIM.RACE_LAPS, seed: 2026 };
  const strategy = createStrategyScreen(container, track, setup);
  const result = createResultScreen(container, track);

  // in-race live strategy overlay (M)
  const overlayEl = document.createElement('div');
  overlayEl.className = 'race-strat-overlay';
  overlayEl.style.display = 'none';
  overlayEl.innerHTML = `<div class="rso-hint">LIVE STRATEGY — click zones to re-map · racing continues · press M to close</div>`;
  container.appendChild(overlayEl);
  const overlayMap = new TrackMap(track, { interactive: true, showLabels: true, zoneWidth: 6 });
  overlayEl.appendChild(overlayMap.canvas);

  // pause menu (Esc)
  const pauseEl = document.createElement('div');
  pauseEl.className = 'pause-overlay';
  pauseEl.style.display = 'none';
  pauseEl.innerHTML = `
    <div class="pause-card">
      <div class="pause-title">PAUSED</div>
      <button class="btn btn-primary pause-resume">RESUME</button>
      <button class="btn pause-restart">RESTART</button>
      <button class="btn pause-strategy">CHANGE STRATEGY</button>
      <button class="btn pause-quit">QUIT TO MENU</button>
    </div>`;
  container.appendChild(pauseEl);

  // ---- game state
  let screen: Screen = 'menu';
  let race: RaceController | null = null;
  let idle = new RaceController(track, raceOpts(setup, mode));
  let timeScale = 1;
  let savedTimeScale = 1;
  let accumulator = 0;
  let overlayOpen = false;
  let paused = false;
  let spectate = false; // optimal mode: no manual player input
  let soloRace = false; // timetrial / optimal: rival hidden

  // ---- multiplayer (2-4 player head-to-head) state
  interface RosterEntry { peerId: string; name: string; carId: string; ready: boolean }
  let net: RoomHandle | null = null;
  let netRole: NetRole | null = null;
  let roster: RosterEntry[] = [];              // host-authoritative; broadcast to all
  let lapsSetting: number = SIM.RACE_LAPS;     // host-chosen lap count
  let localCarId = 'player';                   // this client's own car ('p0'..'p3' in MP)
  let netState: RaceState | null = null;       // guest: latest host snapshot (all cars, raw ids)
  const hostInputs = new Map<string, { boostHeld: boolean; aggressiveness: number }>(); // host: carId -> input
  const myMpInput = { boostHeld: false, aggressiveness: 1 };  // local player's own input
  let myName = 'Player';
  let lastNetSend = 0;
  // matchmaking (quick match): a fixed public room; host is elected by lowest id
  let matchmaking = false;
  let matchTimer: ReturnType<typeof setTimeout> | null = null;
  let matchCountN = 0;
  const MATCH_ROOM = 'OVERRIDE-QUICKMATCH';

  // race capture
  let gapHistory: number[] = [];
  let lastGapSample = 0;
  let playerEnergy: LapEnergy[] = [];
  let rivalEnergy: LapEnergy[] = [];
  let eventCursor = 0;
  let confirmedLead: 'player' | 'rival' = 'rival';
  let pendingLead: 'player' | 'rival' = 'rival';
  let pendingSince = 0;
  let finalLapAnnounced = false;

  // time-trial ghost
  let ghost: GhostTrace | null = null;        // all-time best to race against
  let recTrace: GhostTrace = { t: [], s: [] }; // current lap being recorded
  let recLastSample = -1;
  let bestSessionLap = Infinity;
  let bestSessionTrace: GhostTrace | null = null;

  const activeState = (): RaceState => (race ?? idle).getState();

  function raceOpts(s: RaceSetup, m: GameMode, rivalMap?: DeployMap): RaceOptions {
    const solo = m === 'timetrial' || m === 'optimal';
    return {
      laps: m === 'timetrial' ? TIMETRIAL_LAPS : m === 'optimal' ? 1 : m === 'overtake' ? OVERTAKE_LAPS : s.laps,
      seed: s.seed,
      playerMap: s.playerMap,
      rivalSkill: s.rivalSkill,
      rivalMap,
      solo,
      playerStartBackM: m === 'overtake' ? OVERTAKE_START_BACK_M : undefined,
    };
  }

  let jumpStarted = false;

  async function startRace(s: RaceSetup, lights = true): Promise<void> {
    setup = s;
    soloRace = mode === 'timetrial' || mode === 'optimal';
    spectate = mode === 'optimal';
    let rivalMap: DeployMap | undefined;
    if (mode === 'overtake') {
      // strong-but-beatable rival: the solved optimal, trimmed in its 2 best zones
      const [opt, analysis] = await Promise.all([solveOptimal(track), analyzeZones(track)]);
      const highValue = analysis.zones.slice().sort((a, b) => b.deployValueSec - a.deployValueSec).map((z) => z.zoneId);
      rivalMap = challengeRivalMap(opt.map, highValue);
    }
    race = new RaceController(track, raceOpts(s, mode, rivalMap)); // stays on the grid until lights-out
    accumulator = 0;
    gapHistory = []; lastGapSample = 0; playerEnergy = []; rivalEnergy = [];
    eventCursor = 0; confirmedLead = 'rival'; pendingLead = 'rival'; pendingSince = 0; finalLapAnnounced = false;
    timeScale = 1;
    jumpStarted = false;
    // ghost setup (time trial)
    ghost = mode === 'timetrial' ? (getBestLap()?.ghost ?? null) : null;
    ghostModel.root.visible = false;
    recTrace = { t: [], s: [] }; recLastSample = -1;
    bestSessionLap = Infinity; bestSessionTrace = null;
    banners.clear();
    setScreen('race');
    const go = (): void => { race?.start(0); banners.push(startBanner(), 'info', startSub(), 2200); };
    if (lights) await startLights.run({ onLightsOut: go });
    else go();
  }

  function startBanner(): string {
    return mode === 'overtake' ? 'CHASE IT DOWN' : mode === 'optimal' ? 'OPTIMAL LAP' : mode === 'timetrial' ? 'HOT LAP' : 'LIGHTS OUT';
  }
  function startSub(): string {
    if (mode === 'overtake') return 'get within 1.0s to unlock Override';
    if (mode === 'optimal') return 'watch the solved strategy drive';
    if (mode === 'timetrial') return 'beat your best — hold SPACE to deploy';
    return 'hold SPACE for Manual Override';
  }

  function setScreen(next: Screen): void {
    screen = next;
    if (next !== 'race') startLights.abort();
    menu.hide(); modeSelect.hide(); strategy.hide(); result.hide(); lobby.hide();
    raceUi.style.display = next === 'race' ? 'block' : 'none';
    if (next === 'race') setControls(mode);
    overlayEl.style.display = 'none';
    pauseEl.style.display = 'none';
    overlayOpen = false; paused = false;
    if (next === 'menu') { menu.show(); idle = new RaceController(track, raceOpts(setup, mode)); }
    else if (next === 'modeselect') modeSelect.show();
    else if (next === 'strategy') strategy.show();
    else if (next === 'lobby') { lobby.setPhase('choose'); lobby.show(); }
  }

  menu.onStart(() => setScreen('modeselect'));
  modeSelect.onBack(() => setScreen('menu'));
  modeSelect.onSingle((m) => { mode = m; setScreen('strategy'); });
  modeSelect.onMultiplayer((kind) => {
    mode = 'multiplayer';
    if (kind === 'find') startMatchmaking();
    else setScreen('lobby');
  });
  strategy.onRace((s) => void startRace(s));
  result.onAgain(() => { if (mode === 'multiplayer') { leaveMp(); setScreen('modeselect'); } else void startRace(setup); });
  result.onStrategy(() => { if (mode === 'multiplayer') { leaveMp(); setScreen('modeselect'); } else { strategy.setMap(setup.playerMap); setScreen('strategy'); } });
  result.onMenu(() => { leaveMp(); setScreen('modeselect'); });

  const resume = (): void => { paused = false; pauseEl.style.display = 'none'; timeScale = savedTimeScale; };
  pauseEl.querySelector('.pause-resume')!.addEventListener('click', () => {
    if (screen === 'lobby') { setScreen('modeselect'); return; }
    resume();
  });
  pauseEl.querySelector('.pause-restart')!.addEventListener('click', () => void startRace(setup));
  pauseEl.querySelector('.pause-strategy')!.addEventListener('click', () => { strategy.setMap(setup.playerMap); setScreen('strategy'); });
  pauseEl.querySelector('.pause-quit')!.addEventListener('click', () => { leaveMp(); setScreen('modeselect'); });

  // ---- multiplayer netcode -------------------------------------------------
  // Host is authoritative: it runs the sim, applies the guest's inputs to the
  // rival car, and broadcasts compact snapshots ~30x/s. The guest renders the
  // snapshots from its OWN perspective (its car re-labelled 'player') and sends
  // its live inputs back. No pre-race map: it's a pure manual-deploy skill duel.
  interface SnapCar {
    id: string; nm?: string; s: number; lap: number; v: number; lat: number; pw: number; thr: number; brk: number;
    gear: number; tow: boolean; clt: number; laps: number[]; best: number | null; sect: number[]; fin: boolean;
    soc: number; harv: number; dep: number; ovrA: boolean; ovrArm: boolean; ovrBonus: number; boost: boolean; aggr: number;
  }
  interface Snap { time: number; phase: string; lapsTotal: number; gap: number; cars: SnapCar[] }

  function snapshot(st: RaceState): Snap {
    return {
      time: st.time, phase: st.phase, lapsTotal: st.lapsTotal, gap: st.gapSeconds,
      cars: st.cars.map((c) => ({
        id: c.id, nm: c.name, s: c.s, lap: c.lap, v: c.v, lat: c.lateralOffset, pw: c.deployPowerW, thr: c.throttle, brk: c.brake,
        gear: c.gear, tow: c.inTow, clt: c.currentLapTime, laps: c.lapTimes, best: c.bestLap, sect: c.currentSectors, fin: c.finished,
        soc: c.energy.soc, harv: c.energy.harvestedThisLap, dep: c.energy.deployedThisLap,
        ovrA: c.energy.overrideActive, ovrArm: c.energy.overrideArmed, ovrBonus: c.energy.overrideBonusRemaining,
        boost: c.inputs.boostHeld, aggr: c.inputs.aggressiveness,
      })),
    };
  }
  function expandCar(s: SnapCar): CarState {
    return {
      id: s.id, name: s.nm, s: s.s, lap: s.lap, v: s.v, lateralOffset: s.lat, deployPowerW: s.pw, throttle: s.thr, brake: s.brk,
      gear: s.gear, inTow: s.tow, currentLapTime: s.clt, lapTimes: s.laps, bestLap: s.best, currentSectors: s.sect,
      finished: s.fin, finishTime: null, totalTime: 0, aeroMode: 'Z', deployMap: emptyMap(track),
      inputs: { boostHeld: s.boost, aggressiveness: s.aggr },
      energy: { soc: s.soc, harvestedThisLap: s.harv, deployedThisLap: s.dep, overrideActive: s.ovrA, overrideArmed: s.ovrArm, overrideBonusRemaining: s.ovrBonus, lastDeployPowerW: s.pw },
    };
  }
  /** guests rebuild the full N-car field from the host snapshot (raw ids); the
   *  renderer focuses on localCarId, so no perspective swap is needed. */
  function expandSnapshot(snap: Snap): RaceState {
    return {
      tick: 0, time: snap.time, phase: snap.phase as RaceState['phase'], session: 'race',
      lapsTotal: snap.lapsTotal, gapSeconds: snap.gap, events: [],
      cars: snap.cars.map(expandCar),
    };
  }

  interface MpResult { carId: string; name: string; finishTime: number | null; laps: number }

  function wireNet(): void {
    if (!net) return;
    net.onPeerJoin(() => {
      // announce ourselves (with our name); the host folds guests into the roster
      net?.send({ t: 'join', name: myName });
      if (matchmaking) electRole();
      updateLobbyPhase(); renderMatchmaking();
    });
    net.onPeerLeave((peerId) => {
      if (netRole === 'host') { roster = roster.filter((e) => e.peerId !== peerId); broadcastRoster(); }
      if (matchmaking) electRole();
      if (screen === 'race') banners.push('A PLAYER LEFT', 'info', undefined, 2500);
      updateLobbyPhase(); renderMatchmaking();
    });
    net.onMessage((m, from) => handleNetMsg(m as { t: string; [k: string]: unknown }, from));
    net.onInput((i, from) => {
      if (netRole !== 'host') return;
      const entry = roster.find((e) => e.peerId === from);
      if (!entry) return;
      const inp = i as { boost?: boolean; aggr?: number };
      hostInputs.set(entry.carId, { boostHeld: !!inp.boost, aggressiveness: typeof inp.aggr === 'number' ? inp.aggr : 1 });
    });
    net.onState((s) => { if (netRole === 'guest') netState = expandSnapshot(s as Snap); });
  }

  /** host: lowest free 'p{n}' slot id (0-3) */
  function nextCarId(): string {
    const used = new Set(roster.map((e) => e.carId));
    for (let i = 0; i < 4; i++) if (!used.has(`p${i}`)) return `p${i}`;
    return 'p3';
  }
  function hostAddOrUpdate(peerId: string, name: string): void {
    const existing = roster.find((e) => e.peerId === peerId);
    if (existing) { existing.name = name; }
    else if (roster.length < 4) { roster.push({ peerId, name, carId: nextCarId(), ready: matchmaking }); } // quick match auto-readies
    broadcastRoster();
  }
  function broadcastRoster(): void {
    if (netRole !== 'host') return;
    net?.send({ t: 'roster', entries: roster, laps: lapsSetting });
    applyRosterToLobby();
    renderMatchmaking();
    checkAutoStart();
  }
  function applyRosterToLobby(): void {
    const players = roster.map((e) => ({
      name: e.name,
      color: SLOT_COLORS[slotOf(e.carId)] ?? '#8a94a2',
      ready: e.ready,
      you: e.peerId === net?.selfId,
      host: e.carId === 'p0',
    }));
    lobby.setRoster(players);
    lobby.setLaps(lapsSetting);
    lobby.setLapsEditable(netRole === 'host');
    updateLobbyPhase();
  }
  function updateLobbyPhase(): void {
    if (screen !== 'lobby') return;
    if (roster.length >= 2) { lobby.setStatus('Connected — ready up!'); lobby.setPhase('connected'); }
  }

  function handleNetMsg(msg: { t: string; [k: string]: unknown }, from: string): void {
    if (msg.t === 'who') { net?.send({ t: 'join', name: myName }); return; } // matchmaking host asks for names
    if (netRole === 'host') {
      if (msg.t === 'join' || msg.t === 'name') hostAddOrUpdate(from, String(msg.name ?? 'Player'));
      else if (msg.t === 'ready') { const e = roster.find((x) => x.peerId === from); if (e) { e.ready = !!msg.ready; broadcastRoster(); } }
    } else {
      if (msg.t === 'roster') { roster = msg.entries as RosterEntry[]; lapsSetting = Number(msg.laps) || SIM.RACE_LAPS; applyRosterToLobby(); renderMatchmaking(); }
      else if (msg.t === 'start') { roster = msg.entries as RosterEntry[]; lapsSetting = Number(msg.laps) || SIM.RACE_LAPS; startMpRace(roster, lapsSetting, Number(msg.seed)); }
      else if (msg.t === 'finish') { showMpResult(msg.results as MpResult[]); }
    }
  }

  // ---- matchmaking (quick match): fixed room, host elected by lowest peer id
  function startMatchmaking(): void {
    leaveMp();
    matchmaking = true;
    netRole = null;
    roster = [];
    mmNameInput.value = myName === 'Player' ? '' : myName;
    net = joinRoom(MATCH_ROOM, 'guest');
    wireNet();
    net.send({ t: 'join', name: myName });
    electRole();
    mmOverlay.style.display = 'flex';
    renderMatchmaking();
  }
  function electRole(): void {
    if (!matchmaking || !net) return;
    const ids = [net.selfId, ...net.peers()].sort();
    const role: NetRole = ids[0] === net.selfId ? 'host' : 'guest';
    if (role === netRole) return;
    netRole = role;
    if (role === 'host') {
      // (re)build the roster: self on pole, then up to 3 known peers, all auto-ready
      const self: RosterEntry = { peerId: net.selfId, name: myName, carId: 'p0', ready: true };
      const others = net.peers().slice(0, 3).map((pid, i) => ({
        peerId: pid, name: roster.find((e) => e.peerId === pid)?.name ?? 'Player', carId: `p${i + 1}`, ready: true,
      }));
      roster = [self, ...others];
      net.send({ t: 'who' }); // ask peers to (re)send their names
      broadcastRoster();
    }
    renderMatchmaking();
  }
  function checkAutoStart(): void {
    if (!matchmaking || netRole !== 'host') return;
    if (roster.length >= 2 && matchTimer === null) startMatchCountdown();
    else if (roster.length < 2) cancelMatchCountdown();
  }
  function startMatchCountdown(): void {
    matchCountN = 5; // seconds — lets a 3rd/4th player still drop in
    const tick = (): void => {
      if (!matchmaking || netRole !== 'host' || roster.length < 2) { cancelMatchCountdown(); return; }
      renderMatchmaking();
      if (matchCountN <= 0) { matchTimer = null; hostStartMp(); return; }
      matchCountN--;
      matchTimer = setTimeout(tick, 1000);
    };
    tick();
  }
  function cancelMatchCountdown(): void {
    if (matchTimer !== null) { clearTimeout(matchTimer); matchTimer = null; }
    matchCountN = 0;
    renderMatchmaking();
  }
  function renderMatchmaking(): void {
    if (!matchmaking || mmOverlay.style.display === 'none') return;
    const n = net ? net.peers().length + 1 : 1;
    const status = mmOverlay.querySelector('.mm-status')!;
    const count = mmOverlay.querySelector('.mm-count')!;
    count.textContent = `${n} ${n === 1 ? 'player' : 'players'} in the lobby`;
    if (matchTimer !== null && matchCountN >= 0) status.textContent = `Match found! Starting in ${matchCountN}…`;
    else status.textContent = n >= 2 ? 'Opponents found — waiting to start…' : 'Searching for players…';
  }

  function hostStartMp(): void {
    if (netRole !== 'host' || roster.length < 2 || !roster.every((e) => e.ready)) return;
    const seed = Math.floor(Math.random() * 1e6);
    net?.send({ t: 'start', entries: roster, laps: lapsSetting, seed });
    startMpRace(roster, lapsSetting, seed);
  }

  function startMpRace(entries: RosterEntry[], laps: number, seed: number): void {
    mode = 'multiplayer'; soloRace = false; spectate = false; netState = null;
    const mine = entries.find((e) => e.peerId === net?.selfId);
    localCarId = mine ? mine.carId : entries[0].carId;
    myMpInput.boostHeld = false; myMpInput.aggressiveness = 1;
    hostInputs.clear();
    if (netRole === 'host') {
      hostInputs.set(localCarId, myMpInput); // host's own car uses the live local input object
      for (const e of entries) if (e.carId !== localCarId) hostInputs.set(e.carId, { boostHeld: false, aggressiveness: 1 });
      race = new RaceController(track, {
        seed, laps,
        cars: entries.map((e) => ({ id: e.carId, name: e.name, human: true, map: emptyMap(track) })),
      });
      resetRaceCapture();
      race.start(3);
    } else {
      race = null; // guest renders host snapshots
      resetRaceCapture();
    }
    cancelMatchCountdown();
    mmOverlay.style.display = 'none';
    banners.clear();
    banners.push('HEAD-TO-HEAD', 'info', `${entries.length} cars · hold SPACE to deploy — best strategist wins`, 2600);
    setScreen('race');
  }

  function showMpResult(results: MpResult[]): void {
    const sorted = [...results].sort((a, b) => (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity));
    const winTime = sorted[0]?.finishTime ?? 0;
    const classification = sorted.map((r, i) => ({
      position: i + 1,
      name: r.name,
      color: SLOT_COLORS[slotOf(r.carId)] ?? '#8a94a2',
      gapText: i === 0 ? '' : (r.finishTime != null ? `+${(r.finishTime - winTime).toFixed(3)}` : 'DNF'),
      laps: r.laps,
      you: r.carId === localCarId,
    }));
    race = null; netState = null;
    setScreen('result'); // hides all screens first, then show the result
    result.show({
      playerWon: !!classification[0]?.you, finalGap: 0, laps: lapsSetting,
      playerLaps: [], rivalLaps: [], gapHistory: [], playerEnergy: [], rivalEnergy: [],
      playerMap: emptyMap(track), mode: 'multiplayer', solo: false, classification,
    });
  }

  function resetRaceCapture(): void {
    accumulator = 0; gapHistory = []; lastGapSample = 0; playerEnergy = []; rivalEnergy = [];
    eventCursor = 0; confirmedLead = 'rival'; pendingLead = 'rival'; pendingSince = 0; finalLapAnnounced = false; timeScale = 1;
  }

  function leaveMp(): void {
    cancelMatchCountdown();
    matchmaking = false;
    mmOverlay.style.display = 'none';
    if (net) { net.leave(); net = null; }
    netRole = null; roster = []; localCarId = 'player'; netState = null; hostInputs.clear();
  }

  lobby.onName((name) => {
    myName = name || 'Player';
    if (netRole === 'host') { const e = roster.find((x) => x.peerId === net?.selfId); if (e) { e.name = myName; broadcastRoster(); } }
    else net?.send({ t: 'name', name: myName });
  });
  lobby.onLaps((laps) => { if (netRole === 'host') { lapsSetting = laps; broadcastRoster(); } });
  lobby.onCreate(() => {
    leaveMp(); netRole = 'host'; myName = lobby.getName() || myName;
    const code = makeRoomCode();
    net = joinRoom(code, 'host'); wireNet();
    roster = [{ peerId: net.selfId, name: myName, carId: 'p0', ready: false }];
    lobby.setRole('host'); lobby.setCode(code); lobby.setPhase('hosting'); lobby.setStatus('Waiting for players…');
    applyRosterToLobby();
  });
  lobby.onJoin((code) => {
    leaveMp(); netRole = 'guest'; myName = lobby.getName() || myName;
    net = joinRoom(code, 'guest'); wireNet();
    lobby.setRole('guest'); lobby.setCode(code); lobby.setPhase('joining'); lobby.setStatus('Connecting…');
    net.send({ t: 'join', name: myName });
  });
  lobby.onReady(() => {
    if (netRole === 'host') { const e = roster.find((x) => x.peerId === net?.selfId); if (e) { e.ready = true; broadcastRoster(); } }
    else net?.send({ t: 'ready', ready: true });
  });
  lobby.onStart(() => hostStartMp());
  lobby.onLeave(() => { leaveMp(); setScreen('modeselect'); });

  overlayMap.onEdit((zoneId, kind) => {
    const p = playerCar();
    if (!p) return;
    if (kind === 'deploy') {
      p.deployMap.zoneDeploy[zoneId] = cycleLevel(p.deployMap.zoneDeploy[zoneId]);
      if (p.deployMap.zoneDeploy[zoneId] > 0) p.deployMap.zoneLift[zoneId] = 0;
    } else {
      p.deployMap.zoneLift[zoneId] = cycleLevel(p.deployMap.zoneLift[zoneId]);
      if (p.deployMap.zoneLift[zoneId] > 0) p.deployMap.zoneDeploy[zoneId] = 0;
    }
    overlayMap.setMap(p.deployMap);
    setup.playerMap = { zoneDeploy: [...p.deployMap.zoneDeploy], zoneLift: [...p.deployMap.zoneLift] };
  });

  function playerCar(): CarState | undefined {
    return activeState().cars.find((c) => c.id === localCarId);
  }

  // ---- input
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyC') { rig.cycle(); return; }
    if (screen !== 'race') return;
    if (e.code === 'Space') {
      if (startLights.isArmed() && !jumpStarted) { jumpStarted = true; banners.push('JUMP START!', 'info', 'wait for lights out', 1200); }
      if (netRole) { myMpInput.boostHeld = true; if (netRole === 'guest') net?.sendInput({ boost: true, aggr: myMpInput.aggressiveness }); }
      else if (!spectate) { const p = playerCar(); if (p) p.inputs.boostHeld = true; }
      e.preventDefault();
    } else if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && !spectate) {
      const d = e.code === 'ArrowUp' ? 0.05 : -0.05;
      if (netRole) {
        myMpInput.aggressiveness = Math.min(1.25, Math.max(0.5, myMpInput.aggressiveness + d));
        if (netRole === 'guest') net?.sendInput({ boost: myMpInput.boostHeld, aggr: myMpInput.aggressiveness });
        banners.push(`DEPLOY TRIM ${(myMpInput.aggressiveness * 100).toFixed(0)}%`, 'info', undefined, 900);
      } else {
        const p = playerCar();
        if (p) {
          p.inputs.aggressiveness = Math.min(1.25, Math.max(0.5, p.inputs.aggressiveness + d));
          banners.push(`DEPLOY TRIM ${(p.inputs.aggressiveness * 100).toFixed(0)}%`, 'info', undefined, 900);
        }
      }
      e.preventDefault();
    } else if (e.code === 'KeyM' && !spectate && mode !== 'multiplayer') {
      toggleOverlay();
    } else if (e.code === 'KeyT') {
      const on = telemetry.toggle();
      banners.push(on ? 'TELEMETRY ON' : 'TELEMETRY MINIMISED', 'info', undefined, 900);
    } else if (e.code === 'Escape') {
      togglePause();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      if (netRole) { myMpInput.boostHeld = false; if (netRole === 'guest') net?.sendInput({ boost: false, aggr: myMpInput.aggressiveness }); }
      else { const p = playerCar(); if (p) p.inputs.boostHeld = false; }
    }
  });

  function toggleOverlay(): void {
    overlayOpen = !overlayOpen;
    overlayEl.style.display = overlayOpen ? 'flex' : 'none';
    if (overlayOpen) { const p = playerCar(); if (p) overlayMap.setMap(p.deployMap); sizeOverlayMap(); }
  }
  function togglePause(): void {
    paused = !paused;
    if (paused) { savedTimeScale = timeScale; timeScale = 0; pauseEl.style.display = 'flex'; }
    else resume();
  }
  function sizeOverlayMap(): void {
    const s = Math.min(container!.clientWidth * 0.6, container!.clientHeight * 0.72);
    overlayMap.resize(s, s);
  }

  function raceTickOnce(): void {
    const r = race;
    if (!r) return;
    const st = r.getState();
    if (st.phase === 'finished') return;
    // multiplayer host: drive every car from its player's latest inputs, then
    // step. The MP result is a classification, so skip the 2-car capture charts.
    if (netRole === 'host') {
      for (const c of st.cars) {
        const inp = hostInputs.get(c.id);
        if (inp) { c.inputs.boostHeld = inp.boostHeld; c.inputs.aggressiveness = inp.aggressiveness; }
      }
      r.step();
      return;
    }
    const pc = st.cars.find((c) => c.id === 'player')!;
    const rc = st.cars.find((c) => c.id === 'rival')!;
    const pPrev = pc.lap, rPrev = rc.lap;
    const pSnap = { d: pc.energy.deployedThisLap, h: pc.energy.harvestedThisLap };
    const rSnap = { d: rc.energy.deployedThisLap, h: rc.energy.harvestedThisLap };
    r.step();
    // ghost recording (time trial): sample the current lap; on completion keep
    // the fastest and update the session/all-time best.
    if (mode === 'timetrial' && st.phase === 'racing') {
      if (pc.currentLapTime - recLastSample >= GHOST_SAMPLE_S) {
        recTrace.t.push(pc.currentLapTime);
        recTrace.s.push(pc.lap * track.length + pc.s);
        recLastSample = pc.currentLapTime;
      }
    }
    if (pc.lap > pPrev) {
      if (mode === 'timetrial' && pPrev >= 1) {
        const lapTime = pc.lapTimes[pc.lapTimes.length - 1];
        if (lapTime < bestSessionLap) { bestSessionLap = lapTime; bestSessionTrace = normalizeTrace(recTrace, pPrev); }
      }
      recTrace = { t: [], s: [] }; recLastSample = -1;
    }
    if (pc.lap > pPrev && pPrev >= 1) playerEnergy.push({ deployed: pSnap.d / 1e6, harvested: pSnap.h / 1e6 });
    if (rc.lap > rPrev && rPrev >= 1) rivalEnergy.push({ deployed: rSnap.d / 1e6, harvested: rSnap.h / 1e6 });
    if (st.phase === 'racing' && st.time - lastGapSample >= 0.2) { gapHistory.push(st.gapSeconds); lastGapSample = st.time; }
  }

  /** rebase a recorded lap trace so s runs 0..lapLength within the lap. */
  function normalizeTrace(tr: GhostTrace, lapIndex: number): GhostTrace {
    const base = lapIndex * track.length;
    return { t: [...tr.t], s: tr.s.map((s) => s - base) };
  }

  /** ghost arc length at a given lap-time (m within the lap), linearly interpolated. */
  function ghostSAt(g: GhostTrace, lapT: number): number {
    if (g.t.length === 0) return 0;
    if (lapT <= g.t[0]) return g.s[0];
    if (lapT >= g.t[g.t.length - 1]) return g.s[g.s.length - 1];
    let lo = 0, hi = g.t.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (g.t[mid] <= lapT) lo = mid; else hi = mid; }
    const f = (lapT - g.t[lo]) / (g.t[hi] - g.t[lo] || 1);
    return g.s[lo] + (g.s[hi] - g.s[lo]) * f;
  }

  function stepRaceTicks(realDt: number): void {
    const r = race;
    if (!r) return;
    const st = r.getState();
    accumulator += realDt * timeScale;
    let ticks = 0;
    while (accumulator >= SIM.DT && st.phase !== 'finished' && ticks < MAX_TICKS_PER_FRAME) {
      raceTickOnce(); accumulator -= SIM.DT; ticks++;
    }
    processEvents(st);
    if (st.phase === 'finished') finishRace(st);
  }

  function processEvents(st: RaceState): void {
    for (; eventCursor < st.events.length; eventCursor++) {
      const ev = st.events[eventCursor];
      if (ev.kind === 'override-armed' && ev.carId === 'player') { banners.push('OVERRIDE ARMED', 'override', 'hold SPACE to strike'); audio.chime(); }
      else if (ev.kind === 'lap-complete' && ev.carId === 'player') {
        const lt = typeof ev.data?.lapTime === 'number' ? ev.data.lapTime : NaN;
        banners.push(`LAP ${ev.data?.lap ?? ''} · ${fmtLap(lt)}`, 'lap', undefined, 1500);
      } else if (ev.kind === 'energy-depleted' && ev.carId === 'player') { banners.push('BATTERY DEPLETED', 'info', 'harvest to recover', 1400); }
    }
    const p = st.cars.find((c) => c.id === 'player');
    if (p && !finalLapAnnounced && p.lap >= st.lapsTotal && !p.finished && st.phase === 'racing') { finalLapAnnounced = true; banners.push('FINAL LAP', 'final'); }
    if (!soloRace) {
      const lead: 'player' | 'rival' = st.gapSeconds < 0 ? 'player' : 'rival';
      if (lead !== confirmedLead) {
        if (lead !== pendingLead) { pendingLead = lead; pendingSince = st.time; }
        else if (st.time - pendingSince > LEAD_CONFIRM_S) {
          confirmedLead = lead;
          banners.push(lead === 'player' ? 'OVERTAKE — P1' : 'LOST THE LEAD', lead === 'player' ? 'overtake' : 'info');
        }
      } else pendingLead = lead;
    }
  }

  function finishRace(st: RaceState): void {
    // multiplayer host: build the classification, broadcast it, then show it
    if (mode === 'multiplayer' && netRole === 'host') {
      const results: MpResult[] = st.cars.map((c) => ({ carId: c.id, name: c.name ?? c.id, finishTime: c.finishTime, laps: c.lap }));
      net?.send({ t: 'finish', results });
      showMpResult(results);
      return;
    }
    const p = st.cars.find((c) => c.id === 'player')!;
    const rc = st.cars.find((c) => c.id === 'rival')!;
    const bestLap = p.bestLap ?? Math.min(...(p.lapTimes.length ? p.lapTimes : [Infinity]));

    // mode-specific verdict
    let verdict: RaceResult['verdict'];
    if (mode === 'overtake') {
      const won = st.gapSeconds < 0;
      verdict = { kind: won ? 'challenge-win' : 'challenge-loss', title: won ? 'OVERTAKE COMPLETE' : 'COULDN\'T HOLD ON', note: won ? 'You passed and held the lead.' : 'Not this time — get closer, save Override for the straights.' };
    } else if (mode === 'timetrial') {
      const isRecord = Number.isFinite(bestLap) && saveBestLapIfBetter({ time: bestLap, map: setup.playerMap, ghost: bestSessionTrace ?? { t: [], s: [] } });
      verdict = { kind: isRecord ? 'record' : 'laptime', title: isRecord ? 'NEW BEST LAP' : 'LAP COMPLETE', note: `Best this run: ${fmtLap(bestLap)}` + (isRecord ? ' — saved as your record.' : '') };
    } else if (mode === 'optimal') {
      verdict = { kind: 'laptime', title: 'OPTIMAL LAP', note: `Fastest lap: ${fmtLap(bestLap)}` };
    } else {
      verdict = undefined;
    }

    const res: RaceResult = {
      playerWon: st.gapSeconds < 0,
      finalGap: st.gapSeconds,
      laps: st.lapsTotal,
      playerLaps: [...p.lapTimes],
      rivalLaps: [...rc.lapTimes],
      gapHistory: [...gapHistory],
      playerEnergy: [...playerEnergy],
      rivalEnergy: [...rivalEnergy],
      playerMap: { zoneDeploy: [...setup.playerMap.zoneDeploy], zoneLift: [...setup.playerMap.zoneLift] },
      rivalMap: { zoneDeploy: [...rc.deployMap.zoneDeploy], zoneLift: [...rc.deployMap.zoneLift] },
      mode,
      solo: soloRace,
      verdict,
    };
    race = null;
    setScreen('result');
    result.show(res);
  }

  // ---- car posing
  const scratch = { pos: new THREE.Vector3(), fwd: new THREE.Vector3() };
  const ghostScratch = { pos: new THREE.Vector3(), fwd: new THREE.Vector3() };
  const playerPos = new THREE.Vector3();
  const playerFwd = new THREE.Vector3();
  const view = { position: playerPos, forward: playerFwd, s: 0, speed: 0 };

  function poseCar(model: CarModelHandle, st: CarState, pos: THREE.Vector3, fwd: THREE.Vector3, dt: number): void {
    const pose = trackAt(track, st.s);
    const rawOff = sampleLerp(line.offset, st.s) + st.lateralOffset;
    const off = Math.max(-(pose.wRight - 0.9), Math.min(pose.wLeft - 0.9, rawOff));
    pos.set(pose.x + off * pose.nx, 0, -(pose.y + off * pose.ny));
    fwd.set(pose.tx, 0, -pose.ty).normalize();
    const k = sampleLerp(line.kappa, st.s);
    const roll = THREE.MathUtils.clamp(k * st.v * st.v * 0.0008, -0.05, 0.05);
    model.setPose(pos, fwd, roll);
    model.setSteer(k * WHEELBASE);
    model.spinWheels(st.v * dt);
    model.setBoostGlow(st.deployPowerW > BOOST_GLOW_W || st.energy.overrideActive);
  }

  /** place the ghost car at its recorded position for the player's current lap time. */
  function poseGhost(p: CarState, dt: number): void {
    if (!ghost || ghost.t.length < 2) { ghostModel.root.visible = false; return; }
    const gs = wrapS(track, ghostSAt(ghost, p.currentLapTime));
    const pose = trackAt(track, gs);
    const off = sampleLerp(line.offset, gs);
    ghostScratch.pos.set(pose.x + off * pose.nx, 0, -(pose.y + off * pose.ny));
    ghostScratch.fwd.set(pose.tx, 0, -pose.ty).normalize();
    ghostModel.root.visible = true;
    ghostModel.setPose(ghostScratch.pos, ghostScratch.fwd, 0);
    ghostModel.spinWheels(30 * dt);
  }

  // ---- main loop
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);

    const inRace = screen === 'race' && (race !== null || netRole === 'guest');
    if (inRace) {
      const nowMs = clock.elapsedTime * 1000;
      let st: RaceState | null;
      if (netRole === 'guest') {
        // guest: no local sim — send inputs, render the host's snapshot
        if (nowMs - lastNetSend > 33) { net?.sendInput({ boost: myMpInput.boostHeld, aggr: myMpInput.aggressiveness }); lastNetSend = nowMs; }
        st = netState;
      } else {
        stepRaceTicks(dt);
        st = activeState();
        if (netRole === 'host' && race && nowMs - lastNetSend > 33) { net?.sendState(snapshot(st)); lastNetSend = nowMs; }
      }
      if (st && mode === 'multiplayer') {
        // ---- 2-4 car multiplayer: pose every car by its colour slot, float a
        // name label above each, and focus camera/HUD on the local player's car.
        const local = st.cars.find((c) => c.id === localCarId) ?? st.cars[0];
        for (const m of carModels) m.root.visible = false;
        for (const l of carLabels) l.sprite.visible = false;
        for (const c of st.cars) {
          const slot = slotOf(c.id);
          const model = carModels[slot];
          const isLocal = c.id === local.id;
          const pos = isLocal ? playerPos : scratch.pos;
          poseCar(model, c, pos, isLocal ? playerFwd : scratch.fwd, dt);
          model.root.visible = true;
          const label = carLabels[slot];
          label.set(c.name ?? `P${slot + 1}`, SLOT_COLORS[slot] ?? '#f4f6f8');
          label.sprite.position.set(pos.x, 2.6, pos.z);
          label.sprite.visible = true;
        }
        ghostModel.root.visible = false;
        const order = st.cars.slice().sort((a, b) => (b.lap * track.length + b.s) - (a.lap * track.length + a.s));
        const position = order.findIndex((c) => c.id === local.id) + 1;
        // gap to the car directly ahead (positive = behind); drives the HUD + override
        const ahead = position >= 2 ? order[position - 2] : null;
        st.gapSeconds = ahead ? ((ahead.lap * track.length + ahead.s) - (local.lap * track.length + local.s)) / Math.max(local.v, 1) : 999;
        hud.update(st, track, false, { localId: local.id, position, field: st.cars.length });
        telemetry.setVisible(true);
        telemetry.update(st, track, false, local.id);
        minimap.update(st.cars, local.deployMap);
        banners.tick(dt);
        audio.updateEngine(local);
        view.s = local.s; view.speed = local.v;
        rig.update(dt, view);
        sceneCtx.updateShadowFocus(playerPos);
        if (overlayOpen) overlayMap.render();
      } else if (st) {
        const p = st.cars.find((c) => c.id === 'player')!;
        const rc = st.cars.find((c) => c.id === 'rival')!;
        carModels[2].root.visible = false; carModels[3].root.visible = false;
        for (const l of carLabels) l.sprite.visible = false;
        poseCar(models.player, p, playerPos, playerFwd, dt);
        models.player.root.visible = true;
        models.rival.root.visible = !soloRace;
        if (!soloRace) {
          poseCar(models.rival, rc, scratch.pos, scratch.fwd, dt);
          p.inTow = rc.lap * track.length + rc.s > p.lap * track.length + p.s && st.gapSeconds > 0 && st.gapSeconds < 1.2;
        }
        if (mode === 'timetrial') poseGhost(p, dt); else ghostModel.root.visible = false;
        hud.update(st, track, soloRace);
        telemetry.setVisible(true);
        telemetry.update(st, track, soloRace);
        minimap.update(soloRace ? [p] : st.cars, p.deployMap);
        banners.tick(dt);
        audio.updateEngine(p);
        view.s = p.s; view.speed = p.v;
        rig.update(dt, view);
        sceneCtx.updateShadowFocus(playerPos);
        if (overlayOpen) overlayMap.render();
      } else {
        banners.tick(dt); // guest waiting for the first snapshot
      }
    } else {
      ghostModel.root.visible = false;
      models.rival.root.visible = true;
      const st = idle.getState();
      poseCar(models.player, st.cars[0], playerPos, playerFwd, 0);
      poseCar(models.rival, st.cars[1], scratch.pos, scratch.fwd, 0);
      orbitAngle += dt * 0.06;
      rig.camera.position.set(ctr.x + Math.cos(orbitAngle) * orbitR, orbitR * 0.72, ctr.z + Math.sin(orbitAngle) * orbitR);
      rig.camera.lookAt(ctr);
      sceneCtx.updateShadowFocus(ctr);
      audio.idle();
      if (screen === 'strategy') strategy.render();
    }
    renderer.render(scene, rig.camera);
  });

  window.addEventListener('resize', () => { if (overlayOpen) sizeOverlayMap(); });

  // ---- first-run onboarding tutorial (guided, spotlights the real controls)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  function tutorialSteps(): OnbStep[] {
    return [
      { title: 'Win on energy, not pace', body: 'Same car as your rival — the race is decided by <b>where you deploy energy</b> (2026 F1 rules). Let\'s learn the controls in 20 seconds.' },
      { title: 'Your deployment map', body: '<b>Left-click</b> a zone to spend energy there; <b>right-click</b> to harvest. You get ~8&nbsp;MJ a lap — spend it where it buys the most speed.', target: '.strat-map', placement: 'right', onEnter: async () => { mode = 'timetrial'; setScreen('strategy'); await sleep(400); } },
      { title: 'See where it pays', body: 'Toggle <b>Show Deploy Value</b> and the track lights up: <b>green</b> where deploying saves the most lap time, red where it\'s wasted.', target: '.coach-heat', placement: 'left' },
      { title: 'Let the sim coach you', body: '<b>Solve Optimal</b> computes the fastest strategy for the track and shows how much time you\'re leaving on the table.', target: '.coach-solve', placement: 'left' },
      { title: 'Be the driver', body: 'In the race, hold <b>SPACE</b> to push-to-deploy at the exact moments you choose — watch the battery drain and the speed climb.' },
      { title: 'The overtake edge', body: 'Get within <b>1.0&nbsp;s</b> of the car ahead to unlock <b>Manual Override</b>: more power at high speed and <b>+0.5&nbsp;MJ</b> of extra energy.' },
      { title: 'Pick a mode', body: 'Time-trial your best lap, watch the optimal, chase down a rival, or race a friend. Good luck out there.', onEnter: async () => { setScreen('modeselect'); await sleep(300); } },
    ];
  }
  async function runTutorial(): Promise<void> {
    if (onboarding.isActive()) return;
    await onboarding.start(tutorialSteps());
    setSeenOnboarding();
  }
  const helpBtn = document.createElement('button');
  helpBtn.className = 'help-btn';
  helpBtn.textContent = '?';
  helpBtn.title = 'How to play';
  helpBtn.addEventListener('click', () => void runTutorial());
  container.appendChild(helpBtn);
  if (!hasSeenOnboarding()) setTimeout(() => void runTutorial(), 1000);

  // ---- debug API
  installDebugApi({
    getState: () => (netRole === 'guest' && netState ? netState : activeState()),
    step: (num: number) => {
      const r = race; if (!r) return;
      const st = r.getState();
      for (let i = 0; i < num && st.phase !== 'finished'; i++) raceTickOnce();
      processEvents(st);
      // multiplayer host: broadcast a snapshot so the guest tracks the sim even
      // when driven by step() (the rAF loop is throttled in headless test tabs)
      if (netRole === 'host' && st.phase !== 'finished') net?.sendState(snapshot(st));
      if (st.phase === 'finished') finishRace(st);
    },
    setTimeScale: (s: number) => { timeScale = Math.max(0, Math.min(50, s)); },
    setSeed: (seed: number) => {
      setup = { ...setup, seed: Math.max(0, Math.floor(seed)) };
      if (screen === 'race') void startRace(setup, false);
      else idle = new RaceController(track, raceOpts(setup, mode));
    },
    setDeploy: (carId, zoneId, level) => {
      const car = activeState().cars.find((c) => c.id === carId);
      if (car && zoneId >= 0 && zoneId < car.deployMap.zoneDeploy.length) {
        car.deployMap.zoneDeploy[zoneId] = Math.max(0, Math.min(1, level));
        if (carId === 'player') setup.playerMap = { zoneDeploy: [...car.deployMap.zoneDeploy], zoneLift: [...car.deployMap.zoneLift] };
      }
    },
    setBoost: (held) => { if (!spectate) { const p = playerCar(); if (p) p.inputs.boostHeld = held; } },
    setCamera: (name: CameraMode) => rig.setCamera(name),
    getScreen: () => screen,
    goto: (next) => {
      if (next === 'race') {
        if (screen === 'strategy') setup = { ...setup, playerMap: strategy.getMap() };
        void startRace(setup, false); // debug/E2E path skips the start-lights
      } else setScreen(next as Screen);
    },
    getProjection: () => {
      const map = screen === 'strategy' ? strategy.getMap() : setup.playerMap;
      const pr = projectLap(track, map);
      return { lapTime: pr.lapTime, deployedMJ: pr.deployedMJ };
    },
    setMap: (carId, map) => {
      const car = activeState().cars.find((c) => c.id === carId);
      if (car) { car.deployMap.zoneDeploy = [...map.zoneDeploy]; car.deployMap.zoneLift = [...map.zoneLift]; }
      if (carId === 'player') { setup.playerMap = { zoneDeploy: [...map.zoneDeploy], zoneLift: [...map.zoneLift] }; strategy.setMap(setup.playerMap); }
    },
    getMode: () => mode,
    setMode: (m: string) => { mode = m as GameMode; },
  }, errors);

  setScreen('menu');
}

function emptyMap(track: { zones: unknown[] }): DeployMap {
  return { zoneDeploy: track.zones.map(() => 0), zoneLift: track.zones.map(() => 0) };
}

void boot();
