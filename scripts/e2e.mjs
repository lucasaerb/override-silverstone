/**
 * End-to-end smoke test. Builds are assumed done; this spins up `vite preview`,
 * drives the real game headlessly through window.__game, and asserts the full
 * flow plus the core balance guarantee (a good strategy wins, an empty one
 * loses) and a clean console. Deterministic: fixed seed, step-based advance.
 *
 *   npm run build && node scripts/e2e.mjs
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const PORT = 4199;
const URL = `http://localhost:${PORT}/`;

const failures = [];
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures.push(`${name} ${detail}`); console.log(`  ✗ ${name} ${detail}`); }
}

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never came up at ${url}`);
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
});

let browser;
try {
  await waitForServer(URL);
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction('window.__game && typeof window.__game.getScreen === "function"', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500));

  console.log('boot');
  check('boots on the menu screen', (await page.evaluate(() => window.__game.getScreen())) === 'menu');
  check('no boot errors', (await page.evaluate(() => window.__game.errors.length)) === 0);

  // ---- mode select: two-level (Single Player / Multiplayer)
  console.log('mode select');
  const modes = await page.evaluate(async () => {
    const g = window.__game;
    g.goto('modeselect');
    await new Promise((r) => setTimeout(r, 150));
    const topCards = document.querySelectorAll('.mode-grid[data-view="top"] .mode-card').length;
    const multiExists = !!document.querySelector('.mode-grid[data-view="top"] .mode-card[data-key="multi"]');
    document.querySelector('.mode-card[data-key="single"]').click(); // → single-player submodes
    await new Promise((r) => setTimeout(r, 120));
    const spCards = document.querySelectorAll('.mode-grid[data-view="single"] .mode-card').length;
    document.querySelector('.mode-card[data-key="timetrial"]').click();
    await new Promise((r) => setTimeout(r, 150));
    return { screen: g.getScreen(), topCards, multiExists, spCards, mode: g.getMode() };
  });
  check('top level shows Single Player + Multiplayer', modes.topCards === 2 && modes.multiExists);
  check('Single Player has three modes', modes.spCards === 3, `(${modes.spCards})`);
  check('selecting a mode opens the strategy screen', modes.screen === 'strategy' && modes.mode === 'timetrial');

  // ---- strategy screen: projection responds to the map
  console.log('strategy + projection');
  const proj = await page.evaluate(async () => {
    const g = window.__game;
    const empty = g.getProjection().lapTime;
    document.querySelector('.preset[data-preset="hunt"]').click();
    await new Promise((r) => setTimeout(r, 300));
    return { empty, hunt: g.getProjection().lapTime };
  });
  check('hunt map projects a faster lap than empty', proj.hunt < proj.empty, `(hunt ${proj.hunt?.toFixed(2)} vs empty ${proj.empty?.toFixed(2)})`);

  // helper: run the current setup to a finished race (debug path, no start-lights)
  const runToFinish = async () =>
    page.evaluate(async () => {
      const g = window.__game;
      g.goto('race');
      let w = 0;
      while (g.getScreen() !== 'race' && w < 8000) { await new Promise((r) => setTimeout(r, 150)); w += 150; } // await async solve
      g.setTimeScale(0);
      let guard = 0;
      while (g.getScreen() === 'race' && guard < 800) { g.step(2500); guard++; }
      return {
        screen: g.getScreen(),
        badge: document.querySelector('.result-badge')?.textContent,
        gap: document.querySelector('.result-gap')?.textContent,
        isSolo: document.querySelector('.result-screen')?.classList.contains('is-solo'),
      };
    });

  // ---- Time Trial: solo hot-lap, result reads a fastest lap
  console.log('time trial');
  const tt = await runToFinish();
  check('time trial reaches result', tt.screen === 'result');
  check('time trial is solo (no rival gap)', tt.isSolo === true);
  check('time trial reports a fastest lap', /\d:\d\d/.test(tt.gap ?? ''), `(${tt.gap})`);

  // ---- Overtake Challenge: a strong map beats the degraded rival; empty map does not
  console.log('overtake challenge');
  const otWin = await page.evaluate(async () => {
    const g = window.__game; g.goto('strategy'); await new Promise((r) => setTimeout(r, 120));
    document.querySelector('.preset[data-preset="hunt"]').click(); await new Promise((r) => setTimeout(r, 250));
    g.setMode('overtake');
  }).then(runToFinish);
  const otLose = await page.evaluate(async () => {
    const g = window.__game; g.goto('strategy'); await new Promise((r) => setTimeout(r, 120));
    document.querySelector('.preset[data-preset="clear"]').click(); await new Promise((r) => setTimeout(r, 250));
    g.setMode('overtake');
  }).then(runToFinish);
  check('overtake reaches result', otWin.screen === 'result');
  check('strong map beats the rival, empty map does not', otWin.badge === 'OVERTAKE COMPLETE' && otLose.badge !== 'OVERTAKE COMPLETE', `(hunt "${otWin.badge}" / empty "${otLose.badge}")`);

  // ---- determinism: same seed → same overtake result
  console.log('determinism');
  const det = await page.evaluate(async () => {
    const g = window.__game;
    const run = async () => {
      g.goto('strategy'); document.querySelector('.preset[data-preset="hunt"]').click(); g.setMode('overtake');
      g.goto('race');
      let w = 0; while (g.getScreen() !== 'race' && w < 8000) { await new Promise((r) => setTimeout(r, 150)); w += 150; }
      g.setTimeScale(0); let guard = 0;
      while (g.getScreen() === 'race' && guard < 800) { g.step(2500); guard++; }
      return document.querySelector('.result-gap')?.textContent;
    };
    const a = await run();
    await new Promise((r) => setTimeout(r, 100));
    const b = await run();
    return { a, b };
  });
  check('same seed reproduces the same finishing gap', det.a === det.b, `(${det.a} vs ${det.b})`);

  check('no console errors across the whole flow', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('no game errors', (await page.evaluate(() => window.__game.errors.length)) === 0);
} finally {
  if (browser) await browser.close();
  server.kill();
}

if (failures.length) {
  console.log(`\nE2E FAILED: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nE2E PASSED');
