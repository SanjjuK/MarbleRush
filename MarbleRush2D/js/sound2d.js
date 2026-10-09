/**
 * Sound for the 2D game, made in the browser with the Web Audio API: no audio files, so nothing to license or download.
 *
 * It only LISTENS to the game (main2d calls `sfx.play(name)`); it never feeds anything back, uses no race code and no
 * race randomness, so it cannot change a race. Browsers keep audio silent until the visitor first taps or presses a key,
 * so the context is created on that first gesture. On by default; the speaker button in the top bar mutes it and the
 * choice is remembered in this browser.
 */
const KEY = 'mr2d.sound';
const MAX_VOICES = 24;                      // a burst of events must not turn into noise

let ctx = null, master = null, noiseBuf = null, bed = null, voices = 0;
let muted = false;
try { muted = localStorage.getItem(KEY) === 'off'; } catch (_) { /* private mode: stay on, forget on reload */ }
const listeners = new Set();
const last = new Map();                     // sound name -> last time it played, for the per-sound rate limit

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();      // keeps a pile-up of sounds from clipping
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.7;
    master.connect(comp); comp.connect(ctx.destination);
    const n = ctx.sampleRate;                         // one second of white noise, reused by every noise sound
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;     // sound only: never race randomness
  } catch (_) { ctx = null; }
  return ctx;
}

/** Send a voice to the master, panned left/right (-1..1) where the browser can. */
function out_(node, pan) {
  if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); node.connect(p); p.connect(master); }
  else node.connect(master);
}

/** A short pitched voice: frequency glides f -> f2, with a fast attack and an exponential fade. */
function tone({ f, f2 = f, type = 'sine', dur = 0.12, gain = 0.15, at = 0, attack = 0.005, lp = 0, pan = 0 }) {
  if (voices >= MAX_VOICES) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let out = g;
  if (lp) { const b = ctx.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = lp; o.connect(b); b.connect(g); } else o.connect(g);
  out_(g, pan);
  voices++;
  o.onended = () => { voices--; try { g.disconnect(); } catch (_) { /* gone */ } };
  o.start(t); o.stop(t + dur + 0.05);
  return out;
}

/** A burst of filtered noise. */
function noise({ dur = 0.2, gain = 0.15, at = 0, type = 'lowpass', freq = 800, freq2 = 0, q = 0.8, attack = 0.004, pan = 0 }) {
  if (voices >= MAX_VOICES) return;
  const t = ctx.currentTime + at;
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf;
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (freq2) f.frequency.exponentialRampToValueAtTime(freq2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); out_(g, pan);
  voices++;
  s.onended = () => { voices--; try { g.disconnect(); } catch (_) { /* gone */ } };
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
}

const arp = (notes, { type = 'triangle', gap = 0.09, dur = 0.18, gain = 0.13 } = {}) => notes.forEach((f, i) => tone({ f, type, dur: i === notes.length - 1 ? dur * 2 : dur, gain, at: i * gap }));

/** Every sound the game makes. `min` is the shortest gap (ms) between two plays of the same sound. */
const SOUNDS = {
  click:   { min: 40,   run: () => tone({ f: 1250, f2: 900, dur: 0.04, gain: 0.07 }) },
  pick:    { min: 40,   run: () => tone({ f: 640, f2: 860, type: 'triangle', dur: 0.08, gain: 0.1 }) },
  bet:     { min: 200,  run: () => { tone({ f: 988, type: 'square', dur: 0.07, gain: 0.06 }); tone({ f: 1319, type: 'square', dur: 0.16, gain: 0.06, at: 0.07 }); noise({ type: 'highpass', freq: 5000, dur: 0.18, gain: 0.04, at: 0.07 }); } },
  start:   { min: 500,  run: () => { tone({ f: 520, f2: 780, type: 'triangle', dur: 0.22, gain: 0.1 }); tone({ f: 780, f2: 1040, type: 'sine', dur: 0.2, gain: 0.07, at: 0.1 }); } },
  tick:    { min: 300,  run: () => tone({ f: 880, dur: 0.13, gain: 0.2 }) },
  go:      { min: 500,  run: () => { tone({ f: 440, f2: 880, type: 'sawtooth', dur: 0.4, gain: 0.1, lp: 2400 }); tone({ f: 660, f2: 1320, type: 'triangle', dur: 0.4, gain: 0.1 }); noise({ type: 'bandpass', freq: 400, freq2: 3000, dur: 0.45, gain: 0.12, q: 0.9 }); } },
  finish:  { min: 90,   run: (rank = 0) => tone({ f: 784 * 2 ** (Math.max(0, 4 - rank) / 12), type: 'triangle', dur: 0.12, gain: 0.1 }) },
  ko:      { min: 150,  run: () => { noise({ freq: 700, freq2: 120, dur: 0.4, gain: 0.22 }); tone({ f: 190, f2: 45, dur: 0.35, gain: 0.22 }); } },
  warpUp:  { min: 150,  run: () => tone({ f: 300, f2: 1300, type: 'sine', dur: 0.32, gain: 0.1 }) },
  warpDown:{ min: 150,  run: () => tone({ f: 900, f2: 180, type: 'sawtooth', dur: 0.36, gain: 0.08, lp: 1200 }) },
  freeze:  { min: 200,  run: () => { noise({ type: 'highpass', freq: 3500, dur: 0.2, gain: 0.09 }); tone({ f: 2200, f2: 1500, dur: 0.25, gain: 0.05 }); } },
  brake:   { min: 200,  run: () => noise({ type: 'bandpass', freq: 2200, freq2: 600, dur: 0.22, gain: 0.1, q: 2 }) },
  grab:    { min: 200,  run: () => tone({ f: 150, f2: 90, type: 'triangle', dur: 0.16, gain: 0.18 }) },
  reorg:   { min: 200,  run: () => tone({ f: 700, f2: 250, type: 'square', dur: 0.2, gain: 0.05, lp: 1500 }) },
  launch:  { min: 200,  run: () => tone({ f: 260, f2: 720, type: 'triangle', dur: 0.4, gain: 0.09 }) },
  win:     { min: 1000, run: () => { arp([523, 659, 784, 1047], { gap: 0.1, gain: 0.14 }); tone({ f: 1568, type: 'sine', dur: 0.6, gain: 0.07, at: 0.42 }); } },
  place:   { min: 1000, run: () => arp([523, 659, 784], { gap: 0.11, gain: 0.12 }) },
  loss:    { min: 1000, run: () => arp([392, 330, 262], { type: 'sine', gap: 0.16, dur: 0.22, gain: 0.12 }) },
  void:    { min: 1000, run: () => arp([440, 440], { type: 'sine', gap: 0.14, gain: 0.09 }) },
  watch:   { min: 1000, run: () => arp([660, 880], { gap: 0.1, gain: 0.08 }) },
  error:   { min: 300,  run: () => { tone({ f: 220, type: 'square', dur: 0.12, gain: 0.05, lp: 900 }); tone({ f: 180, type: 'square', dur: 0.16, gain: 0.05, lp: 900, at: 0.1 }); } },
};

const recent = [];          // times of recent impact-type sounds, for the shared budget
/** Per-kind minimum gap (ms) and a shared budget of `max` sounds per 100 ms, so a busy course stays a clatter, not a wall of noise. */
function allow(kind, gap, max) {
  const t = performance.now();
  if (t - (last.get(kind) || -1e9) < gap) return false;
  while (recent.length && t - recent[0] > 100) recent.shift();
  if (recent.length >= max) return false;
  last.set(kind, t); recent.push(t);
  return true;
}

export const sfx = {
  get muted() { return muted; },
  get ready() { return !!ctx && ctx.state === 'running'; },
  /** Called on the visitor's first tap or key: browsers only allow audio after that. */
  unlock() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  },
  play(name, arg) {
    if (muted || !ctx || ctx.state !== 'running' || document.hidden) return;
    const s = SOUNDS[name];
    if (!s) return;
    const t = performance.now();
    if (t - (last.get(name) || -1e9) < s.min) return;
    last.set(name, t);
    try { s.run(arg); } catch (_) { /* a sound must never break the game */ }
  },
  /**
   * A pinball bumper struck: every bumper has its own note (a pentatonic scale), so a field of them plays a tune.
   * A pop bumper (the orange, springy ones) gets a low bonk with a metal ping. `gain` is 0..1, `pan` -1..1.
   */
  bumper(i, pop, pan = 0, gain = 1) {
    if (muted || !ctx || ctx.state !== 'running' || document.hidden || !allow('bumper', 45, 10)) return;
    try {
      const scale = [523.25, 587.33, 659.25, 783.99, 880];
      const f = scale[(i * 3) % 5] * ((i % 2) ? 1 : 2);
      if (pop) {
        tone({ f: 230, f2: 110, dur: 0.14, gain: 0.2 * gain, pan });
        tone({ f: 1750, f2: 1500, type: 'square', dur: 0.05, gain: 0.05 * gain, pan, lp: 4000 });
      } else {
        tone({ f, type: 'triangle', dur: 0.2, gain: 0.11 * gain, pan });
        tone({ f: f * 2, type: 'sine', dur: 0.12, gain: 0.05 * gain, pan });
      }
    } catch (_) { /* a sound must never break the game */ }
  },
  /** A marble knocked off a wall, a flipper, a spinner or another marble. `strength` is 0..1. */
  impact(strength, pan = 0, marble = false, gain = 1) {
    if (muted || !ctx || ctx.state !== 'running' || document.hidden || !allow('impact', 55, 8)) return;
    try {
      const s = Math.max(0, Math.min(1, strength)) * gain;
      if (marble) {                                             // glass on glass
        tone({ f: 2300 + s * 700, f2: 1900, dur: 0.05, gain: 0.03 + 0.07 * s, pan });
        noise({ type: 'highpass', freq: 5000, dur: 0.03, gain: 0.02 + 0.03 * s, pan });
      } else {                                                  // a marble on a wooden wall
        tone({ f: 380 + s * 220, f2: 220, dur: 0.06, gain: 0.03 + 0.1 * s, pan });
        noise({ type: 'bandpass', freq: 1400 + s * 1600, q: 1.2, dur: 0.04, gain: 0.02 + 0.07 * s, pan });
      }
    } catch (_) { /* a sound must never break the game */ }
  },
  /** A quiet rolling hum under the race: filtered noise, faded in while racing and out after. */
  bed(on) {
    if (on && ctx && ctx.state === 'running' && !muted) {
      if (bed) return;
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
      s.buffer = noiseBuf; s.loop = true;
      f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 0.7;
      lfo.frequency.value = 0.35; lg.gain.value = 140; lfo.connect(lg); lg.connect(f.frequency);       // the hum swells slowly
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 1.2);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(); lfo.start();
      bed = { s, g, lfo };
    } else if (!on && bed) {
      const b = bed; bed = null;
      const t = ctx.currentTime;
      b.g.gain.cancelScheduledValues(t); b.g.gain.setValueAtTime(b.g.gain.value, t); b.g.gain.linearRampToValueAtTime(0.0001, t + 0.6);
      setTimeout(() => { try { b.s.stop(); b.lfo.stop(); b.g.disconnect(); } catch (_) { /* gone */ } }, 800);
    }
  },
  setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(KEY, muted ? 'off' : 'on'); } catch (_) { /* not remembered */ }
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.7, ctx.currentTime, 0.02);
    if (muted) this.bed(false);
    listeners.forEach((fn) => fn(muted));
    if (!muted) { this.unlock(); setTimeout(() => this.play('click'), 60); }
  },
  toggle() { this.setMuted(!muted); },
  onChange(fn) { listeners.add(fn); },
};

// Audio is silent until the visitor does something; the first of these unlocks it.
for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, () => sfx.unlock(), { capture: true, passive: true });
// A hidden tab should be silent (and idle).
document.addEventListener('visibilitychange', () => { if (!ctx) return; if (document.hidden) ctx.suspend().catch(() => {}); else if (!muted) ctx.resume().catch(() => {}); });
