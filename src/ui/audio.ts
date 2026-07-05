/**
 * Procedural WebAudio engine — no asset files (a strict CSP blocks external
 * audio, and shipping a real F1 recording would be a licensing problem for a
 * shareable build, so the engine is synthesised). It layers, RPM-reactive:
 *  - a fundamental + sub-octave sawtooth for the engine body,
 *  - a higher square harmonic + a band-passed noise "scream" for the
 *    characteristic high-rev F1 wail,
 *  - a resonant peaking filter and an RPM-tracking low-pass so it brightens
 *    and howls as the revs climb,
 *  - the 2026 MGU-K deploy whine and a harvest hum,
 *  - a short chime when Manual Override arms.
 *
 * The whole mix sits at a deliberately restrained master level. Browsers block
 * audio until a user gesture, so the context starts suspended; resume() runs on
 * the first interaction (main.ts).
 */
import type { CarState } from '../sim/types';
import { PU } from '../sim/constants';

export interface AudioHandle {
  resume(): void;
  setEnabled(enabled: boolean): void;
  updateEngine(car: CarState): void;
  idle(): void;
  chime(): void;
}

/** master level — kept low so the engine sits under the UI, not over it */
const MASTER_LEVEL = 0.3;

export function createAudio(): AudioHandle {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return nullAudio();

  const ctx = new Ctor();
  const master = ctx.createGain();
  master.gain.value = 0.0;
  master.connect(ctx.destination);

  // -- engine tone stack -> resonant peak -> RPM low-pass -> engine gain
  const eng1 = ctx.createOscillator(); eng1.type = 'sawtooth';                 // fundamental
  const eng2 = ctx.createOscillator(); eng2.type = 'sawtooth'; eng2.detune.value = -6; // sub octave body
  const eng3 = ctx.createOscillator(); eng3.type = 'square';                   // upper-harmonic edge
  const oscMix = ctx.createGain();
  const g1 = ctx.createGain(); g1.gain.value = 0.6;
  const g2 = ctx.createGain(); g2.gain.value = 0.5;
  const g3 = ctx.createGain(); g3.gain.value = 0.14;
  eng1.connect(g1); eng2.connect(g2); eng3.connect(g3);
  g1.connect(oscMix); g2.connect(oscMix); g3.connect(oscMix);

  // band-passed white noise adds the airy top-end "scream"
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  let seed = 1;
  for (let i = 0; i < nd.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; nd[i] = (seed / 0x3fffffff) - 1; }
  const noise = ctx.createBufferSource(); noise.buffer = noiseBuf; noise.loop = true;
  const noiseBP = ctx.createBiquadFilter(); noiseBP.type = 'bandpass'; noiseBP.Q.value = 3.5; noiseBP.frequency.value = 2200;
  const noiseGain = ctx.createGain(); noiseGain.gain.value = 0.05;
  noise.connect(noiseBP); noiseBP.connect(noiseGain);

  const peak = ctx.createBiquadFilter(); peak.type = 'peaking'; peak.Q.value = 4; peak.gain.value = 8; peak.frequency.value = 900;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.7;
  const engGain = ctx.createGain(); engGain.gain.value = 0.0;
  oscMix.connect(peak); noiseGain.connect(peak);
  peak.connect(lp); lp.connect(engGain); engGain.connect(master);

  // -- MGU-K deploy whine (electric) / harvest hum
  const whine = ctx.createOscillator(); whine.type = 'triangle';
  const whineGain = ctx.createGain(); whineGain.gain.value = 0;
  whine.connect(whineGain); whineGain.connect(master);

  for (const o of [eng1, eng2, eng3, whine]) o.start();
  noise.start();

  let enabled = true;
  let started = false;
  const at = (): number => ctx.currentTime;
  const set = (p: AudioParam, v: number, tau = 0.06): void => { p.setTargetAtTime(v, at(), tau); };

  return {
    resume(): void {
      if (ctx.state === 'suspended') void ctx.resume();
      started = true;
      set(master.gain, enabled ? MASTER_LEVEL : 0, 0.4);
    },
    setEnabled(on: boolean): void {
      enabled = on;
      set(master.gain, on && started ? MASTER_LEVEL : 0, 0.2);
    },
    updateEngine(car: CarState): void {
      if (!started) return;
      const kmh = car.v * 3.6;
      // pseudo-RPM: fold speed within the current gear so up/downshifts are audible
      const gearSpan = 42;
      const inGear = (kmh % gearSpan) / gearSpan;
      const f = 58 + car.gear * 5 + inGear * 120 + kmh * 0.42; // fundamental, Hz
      set(eng1.frequency, f);
      set(eng2.frequency, f * 0.5);
      set(eng3.frequency, f * 2);
      // scream band + wail resonance climb with revs
      noiseBP.frequency.setTargetAtTime(1400 + kmh * 12, at(), 0.12);
      peak.frequency.setTargetAtTime(f * 3, at(), 0.1);
      lp.frequency.setTargetAtTime(900 + kmh * 9, at(), 0.1);
      const load = Math.min(1, kmh / 340);
      set(engGain.gain, 0.10 + load * 0.16);          // quieter overall
      set(noiseGain.gain, 0.03 + load * 0.05, 0.12);

      // deploy whine follows MGU-K power; harvest gives a lower, softer hum
      const pw = car.deployPowerW;
      if (pw > 0) {
        const frac = Math.min(1, pw / PU.K_POWER);
        set(whine.frequency, 700 + frac * 900 + kmh * 2, 0.05);
        set(whineGain.gain, 0.015 + frac * (car.energy.overrideActive ? 0.1 : 0.06), 0.05);
      } else if (pw < -1000) {
        set(whine.frequency, 260 + Math.min(1, -pw / PU.K_POWER) * 120, 0.08);
        set(whineGain.gain, 0.022, 0.08);
      } else {
        set(whineGain.gain, 0, 0.12);
      }
    },
    idle(): void {
      set(engGain.gain, 0.05, 0.3);
      set(eng1.frequency, 66, 0.3);
      set(eng2.frequency, 33, 0.3);
      set(eng3.frequency, 132, 0.3);
      set(noiseGain.gain, 0.01, 0.3);
      set(whineGain.gain, 0, 0.3);
    },
    chime(): void {
      if (!started || !enabled) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, at());
      o.frequency.setTargetAtTime(1320, at(), 0.08);
      g.gain.setValueAtTime(0.0001, at());
      g.gain.exponentialRampToValueAtTime(0.12, at() + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, at() + 0.4);
      o.connect(g);
      g.connect(master);
      o.start();
      o.stop(at() + 0.45);
    },
  };
}

function nullAudio(): AudioHandle {
  return { resume() {}, setEnabled() {}, updateEngine() {}, idle() {}, chime() {} };
}
