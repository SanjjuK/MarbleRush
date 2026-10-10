// render2d.js: Canvas drawing. Reads the engine, never writes to it.
//
// The split is the same one race.js keeps in the 3D build, and it matters for
// the same reason: the engine decides the race and the renderer only shows it,
// so nothing here can change a result. Trails, sparks and camera live on this
// side precisely BECAUSE they are allowed to be non-deterministic.
//
// The look is taken from the reference's render(): dark gradient ground,
// section bands with their names set into the background, round-capped strokes
// for walls, glossy radial-gradient marbles with a highlight, a checkered
// finish. What is added is the course furniture we actually have, multiple
// bowls, drain gaps drawn as real arcs, a start gate, a finish gantry, and
// a camera that behaves when the field strings out.

import { TRACK_W } from './track2d.js';
import { paintScenes, paintPops } from './scenes2d.js';

/**
 * The course's own colours. The neutral parts (page, column, walls, pegs) come
 * from the design tokens in css/tokens.css so the canvas and the HUD around it
 * are one palette; the values below are the same tokens as a fallback for
 * anything that imports this without a page (the Node tools). Signal colours
 * (green open, red closed, cryo blue, warp purple) are NOT tokens: they mean
 * something on the course and stay as they are.
 */
const C = {
  bg: '#0E0C0A', ground: '#16130F',
  bgTop: '#0E0C0A', bgBot: '#0E0C0A',
  wall: '#4A4036', wallEdge: '#2F2822', wallHi: 'rgba(237,230,220,0.18)',
  peg: 'rgba(166,157,145,0.55)', ink: '#16130F', gate: '#B3AA9E',
  gold: '#f0cd7c', goldDeep: '#d6b25a',
};

/** Re-read the neutral colours from the page's tokens (cheap; called when a renderer is made). */
function readTheme() {
  if (typeof document === 'undefined') return;
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  const bg = v('--bg'), ground = v('--ground'), edge = v('--track-edge'), strong = v('--line-strong'), t3 = v('--text-3');
  if (bg) C.bg = C.bgTop = C.bgBot = bg;
  if (ground) C.ground = C.ink = ground;
  if (edge) C.wallEdge = edge;
  if (strong) C.wallHi = strong;
  if (v('--text-2')) C.gate = v('--text-2');
  if (t3 && /^#[0-9a-f]{6}$/i.test(t3)) {
    const n = parseInt(t3.slice(1), 16);
    C.peg = `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0.55)`;
  }
}

const MIN_VIEW_H = 640;     // world units always visible vertically
const MAX_SCALE  = 1.35;

/** True for trays whose section gives every cup its own floor. */
function s_quiet(trays, gt) {
  if (!gt.label || gt.multi) return false;
  let n = 0;
  for (const s of trays) if (s.gate !== gt && s.gate.label === gt.label) { n++; if (n) return true; }
  return false;
}

export class Renderer2D {
  constructor(canvas, engine, racers) {
    readTheme();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.racers = racers;
    this.camY = 0;
    this.trails = engine.marbles.map(() => []);
    this.sparks = [];
    this.gone = [];          // knockout animations: { index, x, y, t }
    this.bursts = [];        // warp flashes: { x, y, t, color }
    this.clock = 0;          // cosmetic time, for things that swirl
    this.rot = engine.marbles.map(() => 0);   // coin face angle, from the spin
    this._dpr = 1;
  }

  /**
   * Re-read the element size, and work out what the HUD is NOT covering.
   *
   * The canvas is full-bleed with the panels floating over it, which looks
   * right and is how the reference does it, but the course is a fixed 800
   * wide, so on a narrow window the right-hand standings card sat straight on
   * top of the outside lanes. Two of the five marbles and half the start gate
   * were simply invisible behind it.
   *
   * So the track is framed into the clear rectangle rather than the window.
   * Measured from the live elements instead of hardcoded, because the panels
   * move and resize at the mobile breakpoint.
   */
  resize() {
    const c = this.canvas;
    const p = c.parentElement || document.body;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    this.cw = p.clientWidth;
    this.ch = p.clientHeight;
    c.width = Math.max(1, Math.round(this.cw * dpr));
    c.height = Math.max(1, Math.round(this.ch * dpr));
    c.style.width = this.cw + 'px';
    c.style.height = this.ch + 'px';

    // NOT offsetParent. It is null for every position:fixed element, which is
    // all of them, so an offsetParent guard silently rejects the whole HUD and
    // the safe area quietly becomes the entire window, the bug it was added
    // to fix, still there and now harder to see.
    const box = (el) => {
      if (!el || el.hidden) return null;
      // A panel that floats over the course on purpose (the phone's compact
      // timing tower) says so with --hud: overlay, and is not framed around.
      if (getComputedStyle(el).getPropertyValue('--hud').trim() === 'overlay') return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    };

    // A panel that spans most of the width is a BAND: it costs vertical room.
    // A narrow one is a SIDE CARD: it costs horizontal room. The layout
    // switches between the two at the breakpoint, so decide from the measured
    // box rather than from an assumption about where each panel lives.
    const WIDE = this.cw * 0.55;
    let top = 0, bottomPad = 0, right = this.cw, left = 0;

    for (const el of document.querySelectorAll('[data-hud]')) {
      const r = box(el);
      if (!r) continue;
      // data-hud="top" forces a top band however narrow it is (the betting clock ring hangs from the top bar).
      if (r.width >= WIDE || el.dataset.hud === 'top') {
        // Top or bottom band by its CENTRE, not its top edge. On a phone the
        // betting tote is so tall that its top edge sits above the middle of
        // the screen, so it was classed as a TOP band and the course was
        // framed to start below the bottom of the window: the whole betting
        // phase showed an empty screen.
        if (el.dataset.hud === 'top' || (r.top + r.bottom) / 2 < this.ch * 0.5) top = Math.max(top, r.bottom + 8);
        else bottomPad = Math.max(bottomPad, this.ch - r.top + 8);
      } else if (r.left > this.cw * 0.5) {
        right = Math.min(right, r.left - 12);
      } else if (r.right < this.cw * 0.5) {
        left = Math.max(left, r.right + 12);
      }
    }

    this.safe = {
      x: left,
      y: top,
      w: Math.max(260, right - left),
      h: Math.max(240, this.ch - top - bottomPad),
    };
    if (this.onResize) this.onResize();
  }

  /** Where the course column sits on screen, in CSS pixels: the HUD pins things (the progress rail) to it. */
  courseRect() {
    const s = this.safe, w = TRACK_W * this.scale;
    return { x: s.x + (s.w - w) / 2, y: s.y, w, h: s.h };
  }

  /** World units per CSS pixel, chosen so the course fits the clear area. */
  get scale() {
    const s = this.safe || { w: this.cw, h: this.ch };
    return Math.min(s.w / TRACK_W, s.h / MIN_VIEW_H, MAX_SCALE);
  }

  /**
   * Advance the camera and the cosmetic effects.
   *
   * The camera rides the MEDIAN of the live field, not the leader. Following
   * the leader turns a race into a procession because everyone else leaves the
   * frame; following the mean gets dragged away by a single straggler. This is
   * the same conclusion the 3D spider cam reached, for the same reason.
   */
  update(dt, phase) {
    const E = this.engine;

    this.clock += dt;
    // Turn each coin's face with its rolling. `spin` is set by the engine on
    // every contact and read back by nothing, so this cannot touch a result.
    for (let i = 0; i < E.marbles.length; i++) this.rot[i] += (E.marbles[i].spin || 0) * dt;
    // A knocked-out marble is parked where it was taken. Leaving it in the
    // median would pin the camera to the spot for the rest of the race.
    const focus = this._focus(phase);

    const viewH = this.safe.h / this.scale;
    // The field normally sits 42% down the clear area. When the clear area is only a strip (a phone while betting:
    // the ring above, the sheet below) the gate is brought up under its top edge so the marbles stay in view.
    const anchor = phase !== 'racing' && this.safe.h < 420 ? 0.12 : 0.42;
    const want = Math.max(0, Math.min(focus - viewH * anchor, E.track.height - viewH));
    const k = phase === 'racing' ? 4.5 : 8;
    this.camY += (want - this.camY) * Math.min(1, dt * k);

    for (let i = 0; i < E.marbles.length; i++) {
      const m = E.marbles[i], tr = this.trails[i];
      if (m.out) {
        // First frame it is seen out: start its exit, clear its trail.
        if (!this.gone.some(g => g.index === i)) {
          this.gone.push({ index: i, x: m.x, y: m.y, hx: m.outX, hy: m.outY, t: 0 });
          tr.length = 0;
        }
        continue;
      }
      tr.push({ x: m.x, y: m.y });
      if (tr.length > 16) tr.shift();
    }
    for (const g of this.gone) g.t += dt;
    for (const ev of this.warpQueue || []) {
      this.bursts.push({ x: ev.fromX, y: ev.fromY, t: 0, color: '#ffffff' });
      this.bursts.push({ x: ev.toX, y: ev.toY, t: 0, color: ev.dir > 0 ? '#bfe8ff' : '#aba6a1' });
      this.trails[ev.index].length = 0;       // no streak across the screen
    }
    this.warpQueue = [];
    for (const b of this.bursts) b.t += dt;
    if (this.bursts.length) this.bursts = this.bursts.filter(b => b.t < 0.6);

    // Sparks are spawned from the engine's hit list, so they land where a
    // bumper was actually struck, but their own jitter is plain Math.random:
    // nothing reads them back, so they cannot affect a result.
    for (const idx of E.hits) {
      const b = E.track.bumpers[idx];
      for (let i = 0; i < 5; i++) {
        this.sparks.push({
          x: b.x, y: b.y,
          vx: (Math.random() - 0.5) * 320,
          vy: (Math.random() - 0.5) * 320 - 60,
          life: 0.3 + Math.random() * 0.3,
          color: C.gold,
        });
      }
    }
    for (const p of this.sparks) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 700 * dt;
    }
    if (this.sparks.length) this.sparks = this.sparks.filter(p => p.life > 0);
  }

  /* ------------------------------ cameras ------------------------------ */

  /**
   * Camera modes: 'auto' (the director), 'pack', 'leader', or a marble index
   * to follow. Purely a view: nothing here is read back by the race.
   */
  setCam(mode) { this.camMode = mode; this.camWhy = ''; }

  /** The director hears about events, to cut to them. */
  noteEvent(ev) {
    if (ev.index === undefined || ev.index < 0) return;
    const weight = { out: 3, warp: 2, reorg: 2, freeze: 1.5, grab: 1.2, load: 1.2, brake: 1 }[ev.type];
    if (!weight) return;
    if (this.cut && this.cut.until > this.clock && this.cut.weight > weight) return;
    const why = { out: 'knockout', warp: ev.dir > 0 ? 'warp ahead' : 'warp back', reorg: 'reorg', freeze: 'frozen',
                  grab: 'claw', load: ev.kind === 'rocket' ? 'launch' : ev.kind || 'launch', brake: 'speed camera' }[ev.type];
    this.cut = { index: ev.index, until: this.clock + (ev.type === 'out' ? 2.6 : 2.0), weight, why };
  }

  /** Where the main camera looks this frame, as a world y. */
  _focus(phase) {
    const E = this.engine;
    const live = E.marbles.filter(m => !m.finished && !m.out);
    const pack = () => { const ys = live.map(m => m.y).sort((a, b) => a - b); return ys.length ? ys[ys.length >> 1] : E.track.finishY; };
    const lead = () => { const s = E.standings().find(m => !m.finished && !m.out); return s || E.standings()[0]; };
    const mode = this.camMode ?? 'auto';
    this.camSubject = null;
    if (phase !== 'racing') { this.camWhy = ''; return pack(); }
    if (typeof mode === 'number') {
      const m = E.marbles[mode];
      this.camSubject = m; this.camWhy = m.finished ? 'finished' : m.out ? 'out' : '';
      return m.finished ? E.track.finishY : m.y;
    }
    if (mode === 'leader') { const m = lead(); this.camSubject = m; return m.finished ? E.track.finishY : m.y; }
    if (mode === 'pack') { this.camWhy = 'pack'; return pack(); }
    // AUTO. Cut to whatever just happened; in the run-in, follow the fight for
    // the lead; otherwise the pack.
    if (this.cut && this.cut.until > this.clock) {
      const m = E.marbles[this.cut.index];
      this.camSubject = m; this.camWhy = this.cut.why;
      return m.out ? m.outY : m.y;
    }
    const first = lead();
    const span = E.track.finishY - E.track.sections[0].y0;
    if (first && !first.finished && (first.y - E.track.sections[0].y0) / span > 0.82) {
      const second = E.standings().filter(m => !m.finished && !m.out)[1];
      this.camSubject = first; this.camWhy = 'battle for the lead';
      return second && first.y - second.y < 700 ? (first.y + second.y) / 2 : first.y;
    }
    this.camWhy = 'pack';
    return pack();
  }

  /**
   * One frame of a recorded clip (the knockout replay) into `canvas`,
   * centred on `subject`. The recorded marbles are drawn over the course AS
   * IT WAS at that tick: windmills, doors, holes and pumps are all functions
   * of the tick, so a stand-in engine with the recorded tick poses them
   * exactly. The live engine's poses are put back afterwards.
   */
  drawReplay(canvas, frame, subjectIndex, gone) {
    const E = this.engine;
    const ghost = Object.create(E);
    ghost.tick = frame.tick; ghost.marbles = frame.marbles; ghost.outCount = frame.outCount; ghost.hits = [];
    const saved = [this.engine, this.trails, this.gone, this.sparks, this.bursts];
    this.engine = ghost;
    this.trails = frame.marbles.map(() => []);
    this.gone = gone; this.sparks = []; this.bursts = [];
    ghost._rotorPoses?.(); ghost._moverPoses?.(); if (ghost._doorSegs?.length) ghost._doors(); if (ghost._swayHoles?.length) ghost._sway();
    const m = frame.marbles[subjectIndex];
    this.drawInset(canvas, m.out ? { x: m.outX, y: m.outY } : m, 420);
    [this.engine, this.trails, this.gone, this.sparks, this.bursts] = saved;
    E._rotorPoses?.(); E._moverPoses?.(); if (E._doorSegs?.length) E._doors(); if (E._swayHoles?.length) E._sway();
  }

  draw(phase) {
    const g = this.ctx;
    const dpr = this._dpr, sc = this.scale;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.cw, this.ch);

    // Origin of the world inside the clear rectangle, not the window.
    const s = this.safe;
    g.setTransform(dpr * sc, 0, 0, dpr * sc,
                   (s.x + (s.w - TRACK_W * sc) / 2) * dpr, (s.y - this.camY * sc) * dpr);
    this._world(g, this.camY, this.camY + s.h / sc);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._spotlight(g, s, sc);
  }

  /** A soft glow behind a winning marble (the result screen, view only): `glow` is an rgba() colour. */
  setSpotlight(index, glow) {
    const m = /rgba?\(([^)]+)\)/.exec(glow || '');
    this.spot = m ? { index, inner: glow, outer: `rgba(${m[1].split(',').slice(0, 3).join(',')},0)` } : null;
  }
  _spotlight(g, s, sc) {
    if (!this.spot) return;
    const mb = this.engine.marbles[this.spot.index];
    const x = s.x + (s.w - TRACK_W * sc) / 2 + mb.x * sc, y = s.y + (mb.y - this.camY) * sc, r = 36 + 70 * sc;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, this.spot.inner); grad.addColorStop(1, this.spot.outer);
    g.fillStyle = grad; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }

  /**
   * A close follow-cam on one marble, into its own canvas.
   *
   * The leader runs off the top of the main shot once the field strings out, * that is the price of framing the pack instead of the leader, so this
   * gives it back without compromising the main view.
   */
  drawInset(canvas, subject, across = 330) {
    const g = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, w, h);
    if (!subject) return;

    const sc = w / across;                     // about 330 world units across
    g.setTransform(dpr * sc, 0, 0, dpr * sc,
                   (w / 2 - subject.x * sc) * dpr, (h / 2 - subject.y * sc) * dpr);
    this._world(g, subject.y - h / (2 * sc), subject.y + h / (2 * sc));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * The course and the field, in WORLD coordinates.
   *
   * The CALLER sets the transform. That is what lets the leader inset reuse
   * every line of this at a different scale and centre, instead of keeping a
   * second copy of the drawing code that would quietly drift out of step.
   */
  _world(g, top, bot) {
    const E = this.engine, t = E.track;

    // --- the column the marbles run in: the design's --ground against the page's --bg ---
    g.fillStyle = C.ground;
    g.fillRect(t.wallL, top - 4, t.wallR - t.wallL, bot - top + 8);

    // --- section bands, with the name set into the background ---
    g.textAlign = 'center';
    for (const s of t.sections) {
      if (s.y1 < top - 200 || s.y0 > bot + 200) continue;
      g.fillStyle = 'rgba(255,255,255,0.022)';
      g.fillRect(t.wallL, s.y0, t.wallR - t.wallL, s.y1 - s.y0);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.font = '700 30px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.fillText(s.name.toUpperCase(), TRACK_W / 2, s.y0 + 52);
    }

    // --- crypto set dressing: each crypto section's scene (scenes2d.js) ---
    paintScenes(g, E, top, bot, this.clock);

    // --- off-track lanes: darker, hatched, clearly not the course ---
    for (const o of t.offtrack || []) {
      if (o.y1 < top - 60 || o.y0 > bot + 60) continue;
      g.fillStyle = 'rgba(4, 7, 15, 0.55)';
      g.fillRect(o.x0, o.y0, o.x1 - o.x0, o.y1 - o.y0);
      g.save();
      g.beginPath(); g.rect(o.x0, o.y0, o.x1 - o.x0, o.y1 - o.y0); g.clip();
      g.strokeStyle = 'rgba(166, 157, 145, 0.07)';
      g.lineWidth = 6;
      g.beginPath();
      for (let k = o.x0 - (o.y1 - o.y0); k < o.x1; k += 26) {
        g.moveTo(k, o.y1); g.lineTo(k + (o.y1 - o.y0), o.y0);
      }
      g.stroke();
      g.restore();
      g.font = '700 12px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.textAlign = 'center';
      g.fillStyle = 'rgba(166, 157, 145, 0.45)';
      g.fillText('OFF TRACK', (o.x0 + o.x1) / 2, o.y0 + 24);
    }

    // --- pits: an abyss under the gap, lit hazard-red while it is live ---
    for (const p of t.pits || []) {
      if (p.y1 < top - 60 || p.y0 > bot + 60) continue;
      const gr = g.createLinearGradient(0, p.y0 - 40, 0, p.y1);
      gr.addColorStop(0, E.armed ? 'rgba(224,71,59,0.16)' : 'rgba(144, 137, 129, 0.08)');
      gr.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = gr;
      g.fillRect(p.x0 - 2, p.y0 - 40, p.x1 - p.x0 + 4, p.y1 - p.y0 + 40);
    }

    // --- price charts: candles and an area fill under the line, behind it ---
    this._charts(g, top, bot);

    // --- walls ---
    g.lineCap = 'round';
    g.strokeStyle = C.wall;
    g.lineWidth = 10;
    g.beginPath();
    const pads = [], nets = [], gates = [], doors = [], trays = [], belts = [], lasers = [];
    for (const s of t.segments) {
      if (Math.max(s.ay, s.by) < top - 60 || Math.min(s.ay, s.by) > bot + 60) continue;
      if (s.chart) continue;                      // drawn by _charts, pumps too
      if (s.boost) { pads.push(s); continue; }
      if (s.safe) { nets.push(s); continue; }
      if (s.laser) { lasers.push(s); continue; }
      if (s.tray) { trays.push(s); continue; }
      if (s.belt) { belts.push(s); continue; }
      if (s.gate) { gates.push(s); continue; }
      if (s.door) { doors.push(s); continue; }
      g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by);
    }
    g.strokeStyle = C.wallEdge; g.lineWidth = 12; g.stroke();
    g.strokeStyle = C.wall; g.lineWidth = 8; g.stroke();
    g.strokeStyle = C.wallHi; g.lineWidth = 2; g.stroke();
    g.lineWidth = 10;

    // Safety nets: drawn only once they exist, i.e. once hazards disarm, as a
    // mesh so they read as a net and not as more track.
    if (!E.armed) {
      for (const s of nets) {
        g.lineWidth = 3;
        g.strokeStyle = '#36B368';
        g.setLineDash([7, 5]);
        g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
        g.setLineDash([]);
      }
    }

    // Lasers: lit, a glowing beam you bounce off; off, a faint dashed guide
    // with the emitters still showing at the walls.
    for (const s of lasers) {
      const on = !E.timedGateOpen(s.gate);
      const col = s.laser === 'red' ? '224,71,59' : '54,179,104';
      g.lineCap = 'butt';
      if (on) {
        g.strokeStyle = `rgba(${col},0.35)`; g.lineWidth = 12;
        g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
        g.strokeStyle = `rgb(${col})`; g.lineWidth = 4;
        g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
        g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
      } else {
        g.setLineDash([5, 14]);
        g.strokeStyle = `rgba(${col},0.22)`; g.lineWidth = 2;
        g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
        g.setLineDash([]);
      }
      g.fillStyle = on ? `rgb(${col})` : '#38322C';
      g.fillRect(s.ax - 2, s.ay - 7, 8, 14);
      g.fillRect(s.bx - 6, s.by - 7, 8, 14);
    }

    // Conveyors: a dark belt with chevrons running the way it moves.
    for (const s of belts) {
      const dx = s.bx - s.ax, dy = s.by - s.ay, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
      g.lineCap = 'round';
      g.lineWidth = 12;
      g.strokeStyle = '#38322C';
      g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
      const v = E.beltSpeed(s);
      const dir = Math.sign(v), off = ((this.clock * Math.abs(v)) % 26) * dir;
      g.strokeStyle = v > 0 ? '#36B368' : '#E0473B';
      g.lineWidth = 2.5;
      for (let d = -26; d < L + 26; d += 26) {
        const k = d + off;
        if (k < 4 || k > L - 4) continue;
        const px = s.ax + ux * k, py = s.ay + uy * k;
        g.beginPath();
        g.moveTo(px - ux * 4 * dir - uy * 4, py - uy * 4 * dir + ux * 4);
        g.lineTo(px + ux * 3 * dir, py + uy * 3 * dir);
        g.lineTo(px - ux * 4 * dir + uy * 4, py - uy * 4 * dir - ux * 4);
        g.stroke();
      }
    }

    // Mempool trays: a floor of cups that drops away once per block. Shut,
    // it is a lit, hazard-striped floor with the time to the next block over
    // it; open, it falls away and fades.
    if (trays.length) {
      const blocks = new Map();
      for (const s of trays) {
        const gt = s.gate;
        const isOpen = E.timedGateOpen(gt);
        const at = gt.multi ? (isOpen ? 12 : 0) : (E.tick + gt.phase) % gt.period;
        const drop = isOpen ? Math.min(1, at / 24) : 0;
        g.globalAlpha = 1 - drop * 0.85;
        g.lineCap = 'round';
        g.lineWidth = 9;
        g.strokeStyle = isOpen ? '#36B368' : C.goldDeep;
        g.beginPath(); g.moveTo(s.ax, s.ay + drop * 30); g.lineTo(s.bx, s.by + drop * 30); g.stroke();
        g.globalAlpha = 1;
        const b = blocks.get(gt) || { x0: 1e9, x1: -1e9, y: 0, gt, at, isOpen };
        b.x0 = Math.min(b.x0, s.ax, s.bx); b.x1 = Math.max(b.x1, s.ax, s.bx); b.y = Math.min(s.ay, s.by);
        blocks.set(gt, b);
      }
      // One label per block. Sections with a floor PER CUP (the Airdrop,
      // the Cascade) would print six; they get one shared tag instead.
      // A per-cup section's shared tag goes centred over ALL its cups, clear
      // of the ramps that lead in from the walls (at the left wall it sat
      // on the Cascade's entry ramp).
      const tags = new Map();
      for (const b of blocks.values()) {
        if (!(b.gt.cup !== undefined || s_quiet(trays, b.gt))) continue;
        const key = b.gt.label || 'x', a = tags.get(key) || { x0: 1e9, x1: -1e9, y: 1e9 };
        a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1); a.y = Math.min(a.y, b.y);
        tags.set(key, a);
      }
      const quiet = new Set();
      for (const b of blocks.values()) {
        const cx = (b.x0 + b.x1) / 2;
        if (b.gt.label === 'FLASH CRASH' || b.gt.label === 'RUG PULL') {
          g.font = '700 12px "Barlow Condensed", "Arial Narrow", sans-serif';
          g.textAlign = 'center';
          g.fillStyle = b.isOpen ? '#E0473B' : 'rgba(255,190,200,0.8)';
          g.fillText(b.isOpen ? (b.gt.label === 'RUG PULL' ? 'RUGGED!' : 'CRASH!') : b.gt.label, cx, b.y - 16);
          continue;
        }
        if (b.gt.cup !== undefined || s_quiet(trays, b.gt)) {
          const key = b.gt.label || 'x';
          if (!quiet.has(key)) {
            quiet.add(key);
            g.font = '700 13px "Barlow Condensed", "Arial Narrow", sans-serif';
            const a = tags.get(key);
            g.textAlign = 'center';
            g.fillStyle = '#ffd98a';
            g.fillText(`${key} · every cup on its own timer`, (a.x0 + a.x1) / 2, a.y - 34);
          }
          continue;
        }
        if (b.gt.multi) {
          // Consensus: three validator lights, and the floor drops at 2 of 3.
          const n = b.gt.multi.filter(v => ((E.tick + v.phase) % v.period) < v.open).length;
          b.gt.multi.forEach((v, k) => {
            const on = ((E.tick + v.phase) % v.period) < v.open;
            g.fillStyle = on ? '#36B368' : '#3a2230';
            g.beginPath(); g.arc(cx - 40 + k * 40, b.y - 62, 11, 0, Math.PI * 2); g.fill();
            g.lineWidth = 2; g.strokeStyle = on ? '#b7ffd2' : '#E0473B';
            g.beginPath(); g.arc(cx - 40 + k * 40, b.y - 62, 11, 0, Math.PI * 2); g.stroke();
          });
          g.font = '700 14px "Barlow Condensed", "Arial Narrow", sans-serif';
          g.textAlign = 'center';
          g.fillStyle = b.isOpen ? '#36B368' : '#ffd98a';
          g.fillText(b.isOpen ? `CONSENSUS ${n}/3 · RELEASED` : `VALIDATORS ${n}/3 · NEED 2`, cx, b.y - 86);
          continue;
        }
        const secs = b.isOpen ? 0 : (b.gt.period - b.at) / 240;
        const frac = b.isOpen ? 1 : 1 - (b.gt.period - b.at) / (b.gt.period - b.gt.open);
        // A progress rail under the label: the block filling up.
        g.lineCap = 'round';
        g.lineWidth = 6;
        g.strokeStyle = 'rgba(255,255,255,0.10)';
        g.beginPath(); g.moveTo(cx - 150, b.y - 58); g.lineTo(cx + 150, b.y - 58); g.stroke();
        g.strokeStyle = b.isOpen ? '#36B368' : C.goldDeep;
        g.beginPath(); g.moveTo(cx - 150, b.y - 58); g.lineTo(cx - 150 + 300 * frac, b.y - 58); g.stroke();
        g.font = '700 15px "Barlow Condensed", "Arial Narrow", sans-serif';
        g.textAlign = 'center';
        g.fillStyle = b.isOpen ? '#36B368' : '#ffd98a';
        if (b.gt.label) {
          g.fillText(b.isOpen ? `${b.gt.label} · OPEN` : `${b.gt.label} ${secs.toFixed(1)}s`, cx, b.y - 72);
        } else {
          // The Mempool: pending transactions are the marbles waiting on the
          // tray, and gas climbs with the queue.
          let pending = 0;
          for (const m of E.marbles) if (!m.out && m.x > b.x0 - 60 && m.x < b.x1 + 60 && m.y > b.y - 90 && m.y < b.y + 30) pending++;
          const gwei = 6 + pending * pending * 7;
          g.fillText(b.isOpen ? 'BLOCK MINED · RELEASE' : `NEXT BLOCK ${secs.toFixed(1)}s`, cx, b.y - 72);
          g.font = '600 12px "Barlow Condensed", "Arial Narrow", sans-serif';
          g.fillStyle = 'rgba(255,217,138,0.75)';
          g.fillText(`pending tx ${pending} · gas ${gwei} gwei`, cx, b.y - 38);
        }
      }
    }

    // Timed gates: a striped bar that slides UP out of the way while open,
    // and a small bar beside it that fills towards the next change, so a
    // viewer can see not just whether it is open but when it will flip.
    for (const s of gates) {
      const gt = s.gate;
      const at = (E.tick + gt.phase) % gt.period;
      const isOpen = at < gt.open;
      const len = s.by - s.ay;
      const k = isOpen ? Math.min(1, at / 18, (gt.open - at) / 18) : 0;   // slide, ~75ms
      const top = s.ay - k * len;
      g.lineCap = 'butt';
      g.lineWidth = 12;
      g.strokeStyle = C.gold;
      g.beginPath(); g.moveTo(s.ax, top); g.lineTo(s.bx, top + len); g.stroke();
      g.strokeStyle = C.ink;
      g.lineWidth = 12;
      g.setLineDash([8, 8]);
      g.beginPath(); g.moveTo(s.ax, top); g.lineTo(s.bx, top + len); g.stroke();
      g.setLineDash([]);
      // Timer: fraction of the current phase left.
      const left = isOpen ? 1 - at / gt.open : 1 - (at - gt.open) / (gt.period - gt.open);
      const side = s.ax < 400 ? 18 : -18;
      g.lineWidth = 5;
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.beginPath(); g.moveTo(s.ax + side, s.ay); g.lineTo(s.ax + side, s.by); g.stroke();
      g.strokeStyle = isOpen ? '#36B368' : '#E0473B';
      g.beginPath(); g.moveTo(s.ax + side, s.by); g.lineTo(s.ax + side, s.by - len * left); g.stroke();
      g.font = '700 11px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.textAlign = 'center';
      g.fillStyle = isOpen ? '#36B368' : '#E0473B';
      g.fillText(isOpen ? 'OPEN' : 'SHUT', s.ax + side * 2.2, s.ay - 10);
      g.lineCap = 'round';
    }
    g.lineWidth = 10;

    // Sliding doors: a striped bar at its live position inside a doorway
    // frame. It never stops moving, so a viewer watches it rise and fall as
    // their marble comes in. The doorway's ends are marked so the gap it
    // leaves is obvious.
    for (const s of doors) {
      const d = s.door;
      g.lineCap = 'butt';
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(224,71,59, 0.8)';
      g.beginPath();
      g.moveTo(s.ax - 12, d.y0); g.lineTo(s.ax + 12, d.y0);
      g.moveTo(s.ax - 12, d.y1); g.lineTo(s.ax + 12, d.y1);
      g.stroke();
      g.lineWidth = 12;
      g.strokeStyle = C.gold;
      g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
      g.strokeStyle = C.ink;
      g.setLineDash([8, 8]);
      g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
      g.setLineDash([]);
      g.lineCap = 'round';
    }
    g.lineWidth = 10;

    // Dash pads: a lit strip with chevrons pointing the way it throws.
    for (const s of pads) {
      g.lineWidth = 10;
      g.strokeStyle = '#3B87E6';
      g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
      const dir = Math.sign(s.boost.vx) || 1;
      const x0 = Math.min(s.ax, s.bx), x1 = Math.max(s.ax, s.bx);
      const phase = (this.clock * 90) % 14;
      g.strokeStyle = '#e6f7ff';
      g.lineWidth = 2.5;
      g.beginPath();
      for (let x = x0 + 4 + phase; x < x1 - 4; x += 14) {
        g.moveTo(x - dir * 4, s.ay - 4); g.lineTo(x + dir * 2, s.ay); g.lineTo(x - dir * 4, s.ay + 4);
      }
      g.stroke();
    }
    g.lineWidth = 10;
    g.strokeStyle = C.wall;

    // --- bowls: the ring drawn as arcs BETWEEN the gaps ---
    g.lineWidth = 12;
    for (const b of t.bowls) {
      if (b.y + b.R < top - 60 || b.y - b.R > bot + 60) continue;
      const gaps = [...b.gaps].sort((p, q) => p.angle - q.angle);
      g.beginPath();
      for (let i = 0; i < gaps.length; i++) {
        const cur = gaps[i], next = gaps[(i + 1) % gaps.length];
        const start = cur.angle + cur.half;
        let end = next.angle - next.half;
        if (end <= start) end += Math.PI * 2;
        // moveTo the arc's START, not its end. `arc()` joins to the current
        // point with a straight line when a subpath is already open, so
        // stepping from the previous arc's end drew a chord straight across
        // the drain, the bowl looked closed at the bottom while marbles
        // rolled through the line. The gap is real in the physics either way;
        // this was purely the picture lying about it.
        g.moveTo(b.x + Math.cos(start) * b.R, b.y + Math.sin(start) * b.R);
        g.arc(b.x, b.y, b.R, start, end);
      }
      g.stroke();
    }

    // --- islands (capsules) ---
    g.lineCap = 'round';
    g.strokeStyle = C.peg;
    for (const c of t.capsules) {
      if (Math.max(c.ay, c.by) < top - 120 || Math.min(c.ay, c.by) > bot + 120) continue;
      g.lineWidth = c.r * 2;
      g.beginPath();
      g.moveTo(c.ax, c.ay);
      g.lineTo(c.bx, c.by);
      g.stroke();
    }
    g.lineWidth = 10;

    // --- start gate ---
    if (!E.gateOpen) {
      g.strokeStyle = C.gate;            // the design's quiet bar, not a red line
      g.lineWidth = 8;
      g.beginPath();
      g.moveTo(t.gate.ax, t.gate.ay);
      g.lineTo(t.gate.bx, t.gate.by);
      g.stroke();
    }

    // --- spring pads: a plate on a coil, squashed for a moment when it fires ---
    const SP = t.springs || [];
    for (let i = 0; i < SP.length; i++) {
      const p = SP[i], st = E.pads[i];
      if (Math.max(p.ay, p.by) < top - 60 || Math.min(p.ay, p.by) > bot + 60) continue;
      // A fired pad squashes, flashes, and fades out over ~0.4s: it is gone.
      const fade = st.gone ? Math.max(0, 1 - st.tick / 96) : 1;
      if (fade <= 0) continue;
      g.globalAlpha = fade;
      // Squash for the first ~0.1s after firing, then spring back.
      const k = st.tick >= 0 ? st.tick / 24 : 1;
      const squash = k < 1 ? 1 - Math.sin(k * Math.PI) * 0.6 : 1;
      const depth = 16 * squash;
      const ox = -p.nx * (16 - depth), oy = -p.ny * (16 - depth);
      // Coil: a zigzag between the plate and its base, below the surface.
      g.lineWidth = 3;
      g.strokeStyle = '#c3b9af';
      g.beginPath();
      const n = 7;
      for (let j = 0; j <= n; j++) {
        const f = j / n;
        const bx = p.ax + (p.bx - p.ax) * f, by = p.ay + (p.by - p.ay) * f;
        const z = j % 2 ? depth : 0;
        const x = bx - p.nx * (16 - z) + ox * 0, y = by - p.ny * (16 - z);
        j ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      // The plate itself, lit while recharging.
      g.lineCap = 'round';
      g.lineWidth = 9;
      g.strokeStyle = st.tick >= 0 ? C.gold : '#36B368';
      g.beginPath();
      g.moveTo(p.ax + ox, p.ay + oy); g.lineTo(p.bx + ox, p.by + oy);
      g.stroke();
      g.globalAlpha = 1;
    }

    // --- flippers: drawn at the engine's live pose, lit while mid-stroke ---
    const F = t.flippers || [];
    for (let i = 0; i < F.length; i++) {
      const f = F[i], s = E.flips[i];
      if (f.py + f.len < top - 40 || f.py - f.len > bot + 40) continue;
      const hot = s.tick >= 0 && s.tick < 46;
      g.lineCap = 'round';
      g.lineWidth = f.fr * 2 + 4;
      g.strokeStyle = hot ? C.gold : '#e1dedb';
      g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
      g.lineWidth = f.fr * 2 - 3;
      g.strokeStyle = hot ? '#ff9f1c' : '#E0473B';
      g.beginPath(); g.moveTo(s.ax, s.ay); g.lineTo(s.bx, s.by); g.stroke();
      g.fillStyle = C.ink;
      g.beginPath(); g.arc(s.ax, s.ay, 6, 0, Math.PI * 2); g.fill();
    }
    g.lineWidth = 10;

    // --- black holes ---
    for (const h of t.holes || []) {
      if (h.y + h.pull < top - 40 || h.y - h.pull > bot + 40) continue;
      if (h.kind === 'black') this._hole(g, h, E.armed);
      else this._warpHole(g, h);
    }
    // Where warped marbles come OUT: a brief flash, so a marble appearing
    // from nowhere is explained.
    for (const b of this.bursts) {
      if (b.y < top - 80 || b.y > bot + 80) continue;
      const p = b.t / 0.6;
      g.globalAlpha = Math.max(0, 1 - p);
      g.strokeStyle = b.color;
      g.lineWidth = 4;
      g.beginPath(); g.arc(b.x, b.y, 12 + p * 60, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }

    this._machines(g, top, bot);

    // --- bumpers ---
    for (let bi = 0; bi < t.bumpers.length; bi++) {
      const b = t.bumpers[bi];
      if (b.y < top - 40 || b.y > bot + 40) continue;
      const br = E.pegR ? E.pegR[bi] : b.r;          // a worn bumper shrinks
      if (b.flash > 0) {
        g.beginPath();
        g.arc(b.x, b.y, br + b.flash * 8, 0, Math.PI * 2);
        g.fillStyle = `rgba(255,210,63,${0.30 * b.flash})`;
        g.fill();
      }
      g.beginPath();
      g.arc(b.x, b.y, br, 0, Math.PI * 2);
      g.fillStyle = b.flash > 0 ? C.gold : b.rest > 1 ? '#c2410c' : b.word ? C.goldDeep : C.peg;
      g.fill();
      if (b.rest > 1) {
        g.lineWidth = 3;
        g.strokeStyle = '#ffb46b';
        g.beginPath(); g.arc(b.x, b.y, br - 6, 0, Math.PI * 2); g.stroke();
      }
      if (b.node) {
        // A validator: a hexagon ring, green when it confirms a hit.
        g.lineWidth = 2;
        g.strokeStyle = b.flash > 0 ? '#36B368' : 'rgba(179,170,158,0.7)';
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = k * Math.PI / 3 + Math.PI / 6;
          const px = b.x + Math.cos(a) * (b.r + 5), py = b.y + Math.sin(a) * (b.r + 5);
          k ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.closePath(); g.stroke();
        if (b.flash > 0.6) {
          g.font = '700 10px "Barlow Condensed", "Arial Narrow", sans-serif';
          g.textAlign = 'center';
          g.fillStyle = `rgba(54,179,104,${(b.flash - 0.6) * 2.5})`;
          g.fillText('+1 block', b.x, b.y - b.r - 10 - (1 - b.flash) * 30);
        }
      }
    }

    // --- finish line ---
    if (t.finishY > top - 80 && t.finishY < bot + 80) {
      const sq = 20;
      for (let i = 0; i * sq < t.wallR - t.wallL; i++) {
        for (let j = 0; j < 2; j++) {
          g.fillStyle = (i + j) % 2 === 0 ? '#efedeb' : C.ink;
          g.fillRect(t.wallL + i * sq, t.finishY + j * sq, sq, sq);
        }
      }
    }

    // --- sparks ---
    for (const p of this.sparks) {
      g.globalAlpha = Math.max(0, Math.min(1, p.life * 3));
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // --- marbles ---
    for (let i = 0; i < E.marbles.length; i++) {
      const m = E.marbles[i];
      if (m.out) continue;
      this._marble(g, m, this.trails[i]);
      // Frozen: an ice shell, and the thaw counting down round it.
      if (m.frozen && E.tick < m.frozen && m.frozenBy === 'grab') {
        // In a claw's grip: the claw's hold counting down.
        g.strokeStyle = '#ebe9e6'; g.lineWidth = 3;
        g.beginPath(); g.arc(m.x, m.y, m.r + 6, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
      } else if (m.frozen && E.tick < m.frozen) {
        const left = (m.frozen - E.tick) / (m.frozenFor || 480);   // a worn freeze is not always 2s
        g.fillStyle = 'rgba(190,240,255,0.45)';
        g.beginPath(); g.arc(m.x, m.y, m.r + 5, 0, Math.PI * 2); g.fill();
        g.lineWidth = 3;
        g.strokeStyle = '#e6fbff';
        g.beginPath(); g.arc(m.x, m.y, m.r + 9, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2); g.stroke();
      }
    }

    // Machine pop-ups (minted, bridging, yield...) over the marbles.
    paintPops(g, E);

    // --- knockouts: the marble is drawn falling INTO the hole, shrinking and
    //     spinning in, rather than simply vanishing. Half a second, cosmetic.
    for (const k of this.gone) {
      // REKT: a rubber stamp slammed down where it went out, for two seconds.
      if (k.t < 2.2) {
        const a = Math.min(1, k.t / 0.12), fade = k.t > 1.7 ? 1 - (k.t - 1.7) / 0.5 : 1;
        const sc = 1.6 - 0.6 * a;
        g.save();
        g.translate(k.hx, k.hy - 34);
        g.rotate(-0.22);
        g.scale(sc, sc);
        g.globalAlpha = a * fade;
        g.strokeStyle = '#E0473B'; g.lineWidth = 3;
        g.strokeRect(-44, -17, 88, 34);
        g.font = '700 24px "Barlow Condensed", "Arial Narrow", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = '#E0473B';
        g.fillText('REKT', 0, 1);
        g.textBaseline = 'alphabetic';
        g.restore();
      }
      if (k.t > 0.7) continue;
      const m = E.marbles[k.index];
      const p = Math.min(1, k.t / 0.7);
      let x, y;
      if (m.outBy === 'Black hole') {
        // Spiral in.
        const ang = p * 7, rad = (1 - p) * 24;
        x = k.hx + Math.cos(ang) * rad; y = k.hy + Math.sin(ang) * rad;
      } else {
        // Fall away into the dark.
        x = k.hx; y = k.hy + p * p * 160;
      }
      g.save();
      g.globalAlpha = 1 - p * 0.6;
      this._marble(g, { ...m, x, y, r: m.r * (1 - p * 0.85) }, []);
      g.restore();
    }
  }

  /**
   * The 2026-09-25 machines: fans, updrafts, cryo traps, speed cameras,
   * windmills, moving bumpers and cannons. All drawn from the engine's own
   * state for this tick, so what is on screen is what the physics did.
   */
  _machines(g, top, bot) {
    const E = this.engine, t = E.track;
    const vis = (y0, y1) => y1 > top - 80 && y0 < bot + 80;

    for (let zi = 0; zi < (t.zones || []).length; zi++) {
      const z = t.zones[zi];
      if (!vis(z.y0, z.y1)) continue;
      const on = E.zoneOn(z);
      const w = z.x1 - z.x0, h = z.y1 - z.y0;
      if (z.kind === 'fan') {
        g.fillStyle = on ? 'rgba(120,200,255,0.08)' : 'rgba(120,200,255,0.025)';
        g.fillRect(z.x0, z.y0, w, h);
        // Streamlines, moving the way the air blows, only while on.
        if (on) {
          const L = Math.hypot(z.fx, z.fy), ux = z.fx * E.fanDir(z) / L, uy = z.fy / L;
          g.strokeStyle = 'rgba(190,232,255,0.45)';
          g.lineWidth = 2;
          const n = 9;
          for (let i = 0; i < n; i++) {
            const f = ((this.clock * 1.4 + i * 0.37) % 1);
            const cx = z.x0 + (uy !== 0 ? ((i + 0.5) / n) * w : f * w);
            const cy = z.y0 + (uy !== 0 ? (uy < 0 ? 1 - f : f) * h : ((i + 0.5) / n) * h);
            g.beginPath(); g.moveTo(cx - ux * 14, cy - uy * 14); g.lineTo(cx + ux * 14, cy + uy * 14); g.stroke();
          }
        }
        // The fan housing: a grille on the upwind edge.
        g.fillStyle = on ? '#7cc8ff' : '#4A423A';
        if (z.fy < 0) g.fillRect(z.x0 + 10, z.y1 - 6, w - 20, 6);
        else if (z.fx * E.fanDir(z) > 0) g.fillRect(z.x0 - 4, z.y0 + 6, 6, h - 12);
        else g.fillRect(z.x1 - 2, z.y0 + 6, 6, h - 12);
      } else if (z.kind === 'cryo') {
        g.fillStyle = on ? 'rgba(160,230,255,0.35)' : 'rgba(160,230,255,0.07)';
        g.strokeStyle = on ? '#bdf0ff' : 'rgba(160,230,255,0.35)';
        g.lineWidth = 2;
        g.beginPath(); g.roundRect(z.x0, z.y0, w, h, 8); g.fill(); g.stroke();
        // Snowflake.
        const cx = (z.x0 + z.x1) / 2, cy = (z.y0 + z.y1) / 2;
        g.strokeStyle = on ? '#ffffff' : 'rgba(200,240,255,0.4)';
        for (let k = 0; k < 3; k++) {
          const a = k * Math.PI / 3;
          g.beginPath(); g.moveTo(cx - Math.cos(a) * 11, cy - Math.sin(a) * 11);
          g.lineTo(cx + Math.cos(a) * 11, cy + Math.sin(a) * 11); g.stroke();
        }
      } else if (z.kind === 'grab') {
        // A claw on a cable: open and lit while it can grab.
        const cx = (z.x0 + z.x1) / 2, top = z.y0 - 46;
        const col = z.diamond ? '#7ee8ff' : '#e8d9b0';
        g.strokeStyle = 'rgba(219, 213, 208, 0.5)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(cx, top - 30); g.lineTo(cx, z.y0 - 4); g.stroke();
        const spread = on ? 16 : 7;
        g.strokeStyle = on ? col : 'rgba(179, 173, 168, 0.5)'; g.lineWidth = 4; g.lineCap = 'round';
        for (const d of [-1, 1]) {
          g.beginPath(); g.moveTo(cx, z.y0 - 4); g.lineTo(cx + d * spread, z.y0 + 10);
          g.lineTo(cx + d * (spread - 8), z.y0 + 22); g.stroke();
        }
        g.font = '16px "Barlow Condensed", "Arial Narrow", sans-serif';
        g.textAlign = 'center';
        g.fillText(z.diamond ? '💎' : '🧻', cx, top - 34);
      } else if (z.kind === 'reorg') {
        g.fillStyle = on ? 'rgba(145,97,227,0.28)' : 'rgba(145,97,227,0.06)';
        g.strokeStyle = on ? '#9161E3' : 'rgba(145,97,227,0.35)';
        g.lineWidth = 2;
        g.beginPath(); g.roundRect(z.x0, z.y0, w, h, 8); g.fill(); g.stroke();
        g.font = '700 11px "Barlow Condensed", "Arial Narrow", sans-serif';
        g.textAlign = 'center';
        g.fillStyle = on ? '#f3e8ff' : 'rgba(233,213,255,0.5)';
        g.fillText('↺ REORG', (z.x0 + z.x1) / 2, z.y0 - 6);
      } else if (z.kind === 'well') {
        // A gravity well: rings drawn tighter towards the core, turning. A
        // PULSE well lights up while it has a marble in its grip, a beam to
        // each one as bright as the pull on it, and dims as it lets go.
        let p = 0;
        if (z.pulse) {
          for (const m of E.marbles) {
            const k = E.wellPull(zi, m);
            if (k <= 0) continue;
            p = Math.max(p, k);
            g.strokeStyle = `rgba(147,197,253,${0.15 + 0.6 * k})`; g.lineWidth = 1 + 3 * k;
            g.setLineDash([6, 6]); g.lineDashOffset = -this.clock * 60;
            g.beginPath(); g.moveTo(z.cx, z.cy); g.lineTo(m.x, m.y); g.stroke();
          }
          g.setLineDash([]); g.lineDashOffset = 0;
          if (p > 0) {
            const glow = g.createRadialGradient(z.cx, z.cy, 20, z.cx, z.cy, z.rad);
            glow.addColorStop(0, `rgba(59,135,230,${0.28 * p})`);
            glow.addColorStop(1, 'rgba(59,135,230,0)');
            g.fillStyle = glow; g.beginPath(); g.arc(z.cx, z.cy, z.rad, 0, Math.PI * 2); g.fill();
          }
        }
        const spin = 1 + 3 * p;
        for (let k = 1; k <= 5; k++) {
          const r = z.rad * (k / 5) ** 1.4;
          g.strokeStyle = `rgba(59,135,230,${0.05 + 0.05 * (6 - k) / 5 + 0.25 * p})`; g.lineWidth = 2;
          g.beginPath(); g.arc(z.cx, z.cy, r, this.clock * spin * (1.2 - k * 0.15), this.clock * spin * (1.2 - k * 0.15) + 5); g.stroke();
        }
        g.font = '22px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'center';
        g.fillText('🐋', z.cx, z.cy + 8);
      } else if (z.kind === 'brake') {
        g.setLineDash([8, 6]);
        g.strokeStyle = 'rgba(224,71,59,0.7)';
        g.lineWidth = 2;
        g.strokeRect(z.x0, z.y0, w, h);
        g.setLineDash([]);
        // A speed-limit sign.
        const cx = (z.x0 + z.x1) / 2, cy = z.y0 - 26;
        g.fillStyle = '#ffffff';
        g.beginPath(); g.arc(cx, cy, 20, 0, Math.PI * 2); g.fill();
        g.lineWidth = 5; g.strokeStyle = '#E0473B';
        g.beginPath(); g.arc(cx, cy, 17, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#111';
        g.font = '700 12px "Barlow Condensed", "Arial Narrow", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(Math.round(z.vmax / 10)), cx, cy + 1);
        g.textBaseline = 'alphabetic';
      }
    }

    // Windmills.
    for (const o of t.rotors || []) {
      if (!vis(o.cy - o.len, o.cy + o.len)) continue;
      g.lineCap = 'round';
      for (let a = 0; a < o.arms; a++) {
        const ang = o.angle + a * (Math.PI * 2 / o.arms);
        g.lineWidth = o.fr * 2;
        g.strokeStyle = '#aaa5a1';
        g.beginPath(); g.moveTo(o.cx, o.cy);
        g.lineTo(o.cx + Math.cos(ang) * o.len, o.cy + Math.sin(ang) * o.len); g.stroke();
        g.lineWidth = 3;
        g.strokeStyle = C.goldDeep;
        g.beginPath();
        g.moveTo(o.cx + Math.cos(ang) * (o.len - 18), o.cy + Math.sin(ang) * (o.len - 18));
        g.lineTo(o.cx + Math.cos(ang) * o.len, o.cy + Math.sin(ang) * o.len); g.stroke();
      }
    }

    // Moving bumpers, with their rail.
    for (const o of t.movers || []) {
      if (!vis(Math.min(o.ay, o.by), Math.max(o.ay, o.by))) continue;
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(179,170,158,0.25)';
      g.beginPath(); g.moveTo(o.ax, o.ay); g.lineTo(o.bx, o.by); g.stroke();
      const grd = g.createRadialGradient(o.x - 5, o.y - 5, 2, o.x, o.y, o.r);
      if (o.kind === 'bot' || o.kind === 'runner') {
        // MEV bots: gunmetal with a red eye looking the way they move.
        grd.addColorStop(0, '#787471'); grd.addColorStop(1, '#1f2937');
        g.fillStyle = grd;
        g.beginPath(); g.arc(o.x, o.y, o.r, 0, Math.PI * 2); g.fill();
        const dir = Math.sign(o.vx) || 1;
        g.fillStyle = '#E0473B';
        g.beginPath(); g.arc(o.x + dir * o.r * 0.35, o.y - o.r * 0.15, o.r * 0.22, 0, Math.PI * 2); g.fill();
        if (o.kind === 'runner') {
          g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2;
          for (const k of [-5, 0, 5]) { g.beginPath(); g.moveTo(o.x - dir * (o.r + 4), o.y + k); g.lineTo(o.x - dir * (o.r + 16), o.y + k); g.stroke(); }
        }
        continue;
      }
      grd.addColorStop(0, '#d8b4fe'); grd.addColorStop(1, '#7c3aed');
      g.fillStyle = grd;
      g.beginPath(); g.arc(o.x, o.y, o.r, 0, Math.PI * 2); g.fill();
    }

    // Cannons: a barrel along the firing line, with the fuse of whatever it
    // holds burning down round the muzzle.
    for (let i = 0; i < (t.cannons || []).length; i++) {
      const c = t.cannons[i];
      if (!vis(Math.min(c.y, c.my) - 60, Math.max(c.y, c.my) + 60)) continue;
      const loaded = E.marbles.filter(m => m.held && m.held.cannon === i);
      if (c.kind && c.kind !== 'cannon') { this._launcher(g, c, loaded); continue; }
      const L = Math.hypot(c.vx, c.vy), ux = c.vx / L, uy = c.vy / L;
      g.lineCap = 'round';
      // A capped cannon that has taken its quota is spent: dark and dull,
      // so a viewer sees it will let the next marbles by.
      const spent = c.cap !== undefined && E.cannonState[i].served >= c.cap && !loaded.length;
      g.lineWidth = 30;
      g.strokeStyle = spent ? '#23201C' : '#3A332D';
      g.beginPath(); g.moveTo(c.mx - ux * 40, c.my - uy * 40); g.lineTo(c.mx + ux * 10, c.my + uy * 10); g.stroke();
      g.lineWidth = 3;
      g.strokeStyle = spent ? '#5A4F3A' : C.goldDeep;
      g.beginPath(); g.moveTo(c.mx - ux * 40, c.my - uy * 40); g.lineTo(c.mx + ux * 10, c.my + uy * 10); g.stroke();
      for (const m of E.marbles) {
        if (!m.held || m.held.cannon !== i) continue;
        const left = Math.max(0, (m.held.fire - E.tick) / Math.max(1, c.delay));
        g.lineWidth = 4;
        g.strokeStyle = '#ff7a45';
        g.beginPath(); g.arc(c.mx, c.my, 26, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2); g.stroke();
      }
    }

    // Painted signs (the Bull Trap's lying SHORTCUT).
    for (const sg of t.signs || []) {
      if (!vis(sg.y - 30, sg.y + 30)) continue;
      g.font = '700 13px "Barlow Condensed", "Arial Narrow", sans-serif';
      const w = g.measureText(sg.text).width + 20;
      g.fillStyle = sg.style === 'bull' ? '#15803d' : '#334155';
      g.beginPath(); g.roundRect(sg.x - w / 2, sg.y - 14, w, 26, 6); g.fill();
      g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = '#ffffff'; g.textAlign = 'center';
      g.fillText(sg.text, sg.x, sg.y + 4);
    }
  }

  /** Bridges, vaults and rockets: cannons dressed for the part. */
  _launcher(g, c, loaded) {
    const E = this.engine;
    const fuse = (m) => Math.max(0, (m.held.fire - E.tick) / Math.max(1, m.held.fire - m.held.from));
    if (c.kind === 'bridge') {
      // Two portals and the bridge between them; a marble in transit is a
      // spark travelling along it.
      for (const [x, y, r] of [[c.x, c.y, 30], [c.mx, c.my, 22]]) {
        const grd = g.createRadialGradient(x, y, 2, x, y, r);
        grd.addColorStop(0, 'rgba(129,140,248,0.9)'); grd.addColorStop(1, 'rgba(129,140,248,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#a5b4fc'; g.lineWidth = 3;
        g.beginPath(); g.arc(x, y, r - 6, this.clock * 3, this.clock * 3 + 4.5); g.stroke();
      }
      const mx = (c.x + c.mx) / 2, my = Math.min(c.y, c.my) - 120;
      g.setLineDash([6, 8]); g.strokeStyle = 'rgba(165,180,252,0.35)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(c.x, c.y); g.quadraticCurveTo(mx, my, c.mx, c.my); g.stroke(); g.setLineDash([]);
      for (const m of loaded) {
        const p = 1 - fuse(m);
        const x = (1 - p) * (1 - p) * c.x + 2 * (1 - p) * p * mx + p * p * c.mx;
        const y = (1 - p) * (1 - p) * c.y + 2 * (1 - p) * p * my + p * p * c.my;
        g.fillStyle = this.racers[m.index].hex;
        g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
      }
      g.font = '700 11px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'center';
      g.fillStyle = 'rgba(231, 221, 211, 0.8)';
      g.fillText(loaded.length ? 'CONFIRMING…' : 'BRIDGE', c.x, c.y - 40);
    } else if (c.kind === 'vault') {
      g.fillStyle = '#1e293b'; g.strokeStyle = C.goldDeep; g.lineWidth = 3;
      g.beginPath(); g.roundRect(c.x - 30, c.y - 40, 60, 30, 6); g.fill(); g.stroke();
      g.font = '700 11px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'center';
      g.fillStyle = '#ffd98a';
      g.fillText(loaded.length ? '🔒 STAKED' : 'VAULT', c.x, c.y - 20);
      for (const m of loaded) {
        g.strokeStyle = C.goldDeep; g.lineWidth = 3;
        g.beginPath(); g.arc(m.x, m.y, 24, -Math.PI / 2, -Math.PI / 2 + fuse(m) * Math.PI * 2); g.stroke();
      }
    } else if (c.kind === 'rocket') {
      // A launchpad: gantry and a countdown.
      g.fillStyle = '#334155';
      g.fillRect(c.mx - 34, c.my + 40, 68, 8);
      g.strokeStyle = '#7d766f'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(c.mx - 28, c.my + 40); g.lineTo(c.mx - 28, c.my - 40); g.stroke();
      g.font = '700 12px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'center';
      if (loaded.length) {
        const m = loaded[0], secs = Math.max(0, (m.held.fire - E.tick) / 240);
        g.fillStyle = '#ff7a45';
        g.fillText(`T-${secs.toFixed(1)}`, c.mx, c.my - 50);
      } else {
        g.fillStyle = 'rgba(235, 233, 230, 0.7)';
        g.fillText('🚀 TO THE MOON', c.mx + 20, c.my - 50);
      }
    }
  }

  _charts(g, top, bot) {
    const E = this.engine, t = E.track;
    if (!t.charts || !t.charts.length) return;
    if (!this._chartSegs) {
      this._chartSegs = t.charts.map(c => t.segments.filter(s => s.chart &&
        Math.min(s.ax, s.bx) >= c.pts[0][0] - 1 && Math.max(s.ax, s.bx) <= c.pts[c.pts.length - 1][0] + 1 &&
        Math.max(s.ay, s.by) >= Math.min(...c.pts.map(p => p[1])) - 1 &&
        Math.min(s.ay, s.by) <= Math.max(...c.pts.map(p => p[1])) + 1));
    }
    const hash = (x) => { const v = Math.sin(x * 12.9898) * 43758.5453; return v - Math.floor(v); };
    const mono = '600 12px "Barlow Condensed", "Arial Narrow", sans-serif';

    t.charts.forEach((c, ci) => {
      const ys = c.pts.map(p => p[1]);
      const yTop = Math.min(...ys) - 70, yBot = Math.max(...ys) + 70;
      if (yBot < top - 40 || yTop > bot + 40) return;
      const xL = t.wallL + 4, xR = t.wallR - 4;
      const y0 = c.pts[0][1];
      const price = (y) => 1 + (y0 - y) / 380;           // up the screen = up in price

      // Panel.
      g.fillStyle = 'rgba(8, 12, 22, 0.55)';
      g.fillRect(xL, yTop, xR - xL, yBot - yTop);

      // Grid and price axis.
      g.lineWidth = 1;
      g.font = mono;
      g.textAlign = 'right';
      for (let y = yTop + 20; y < yBot - 10; y += 40) {
        g.strokeStyle = 'rgba(255,255,255,0.05)';
        g.beginPath(); g.moveTo(xL, y); g.lineTo(xR - 64, y); g.stroke();
        g.fillStyle = 'rgba(219, 213, 208, 0.35)';
        g.fillText(price(y).toFixed(4), xR - 8, y + 4);
      }
      for (let x = xL + 60; x < xR - 64; x += 60) {
        g.strokeStyle = 'rgba(255,255,255,0.035)';
        g.beginPath(); g.moveTo(x, yTop); g.lineTo(x, yBot); g.stroke();
      }

      // Candles and volume: several candles per leg, walking the line with
      // seeded noise, so it reads as real price action and not as a ramp.
      for (let i = 0; i + 1 < c.pts.length; i++) {
        const [ax, ay] = c.pts[i], [bx, by] = c.pts[i + 1];
        const n = Math.max(2, Math.round((bx - ax) / 22));
        for (let k = 0; k < n; k++) {
          const f0 = k / n, f1 = (k + 1) / n;
          const x = ax + (bx - ax) * (f0 + f1) / 2;
          const h = hash(x * 1.7 + ay);
          const o = ay + (by - ay) * f0 + (h - 0.5) * 10, cl = ay + (by - ay) * f1 + (hash(x + 3) - 0.5) * 10;
          const up = cl < o;
          const hi = Math.min(o, cl) - 4 - h * 14, lo = Math.max(o, cl) + 4 + hash(x + 7) * 14;
          const col = up ? '54,179,104' : '224,71,59';
          g.strokeStyle = `rgba(${col},0.6)`;
          g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(x, hi - 34); g.lineTo(x, lo - 34); g.stroke();
          g.fillStyle = `rgba(${col},0.5)`;
          g.fillRect(x - 5, Math.min(o, cl) - 34, 10, Math.max(3, Math.abs(cl - o)));
          // Volume.
          const vh = 8 + hash(x * 2.3) * 26 + (up ? 6 : 0);
          g.fillStyle = `rgba(${col},0.22)`;
          g.fillRect(x - 5, yBot - vh, 10, vh);
        }
      }

      // Area under the line.
      const grd = g.createLinearGradient(0, yTop, 0, yBot);
      const endUp = c.pts[c.pts.length - 1][1] < y0;
      grd.addColorStop(0, endUp ? 'rgba(54,179,104,0.18)' : 'rgba(224,71,59,0.18)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(c.pts[0][0], c.pts[0][1]);
      for (const [x, y] of c.pts) g.lineTo(x, y);
      g.lineTo(c.pts[c.pts.length - 1][0], yBot); g.lineTo(c.pts[0][0], yBot); g.closePath(); g.fill();

      // The price line: green rallies, red dips. A flash-crash candle is
      // drawn by the trapdoor renderer's rules: it drops away while open.
      g.lineCap = 'round';
      for (const s of this._chartSegs[ci]) {
        let off = 0, alpha = 1;
        if (s.gate) {
          const at = (E.tick + s.gate.phase) % s.gate.period;
          if (at < s.gate.open) { off = Math.min(1, at / 20) * 26; alpha = 0.35; }
        }
        g.globalAlpha = alpha;
        g.lineWidth = s.chart === 'pump' ? 12 : 8;
        g.strokeStyle = s.chart === 'down' ? (s.gate ? '#E0473B' : '#E0473B') : '#36B368';
        g.beginPath(); g.moveTo(s.ax, s.ay + off); g.lineTo(s.bx, s.by + off); g.stroke();
        g.globalAlpha = 1;
        if (s.gate) {
          g.setLineDash([5, 5]); g.lineWidth = 2; g.strokeStyle = '#ffd1dc';
          g.beginPath(); g.moveTo(s.ax, s.ay + off); g.lineTo(s.bx, s.by + off); g.stroke(); g.setLineDash([]);
        }
        // A pump: chevrons that glow with its strength right now.
        if (s.chart === 'pump') {
          const v = E.pumpSpeed(s.boost), p = s.boost.pulse;
          const k = (v - p.lo) / (p.hi - p.lo);
          g.fillStyle = `rgba(160,255,200,${0.25 + 0.75 * k})`;
          const mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2, ux = s.boost.ux, uy = s.boost.uy;
          for (const d of [-9, 3]) {
            const cx = mx + ux * d, cy = my + uy * d - 16;
            g.beginPath();
            g.moveTo(cx + ux * 8, cy + uy * 8);
            g.lineTo(cx - ux * 4 - uy * 6, cy - uy * 4 + ux * 6);
            g.lineTo(cx - ux * 4 + uy * 6, cy - uy * 4 - ux * 6);
            g.closePath(); g.fill();
          }
        }
      }

      // Last price: follows the marble furthest along this chart.
      const x0 = c.pts[0][0], x1 = c.pts[c.pts.length - 1][0];
      let lead = null;
      for (const m of E.marbles) {
        if (m.out || m.x < x0 || m.x > x1 || m.y < yTop || m.y > yBot) continue;
        if (!lead || m.x > lead.x) lead = m;
      }
      const lineY = (x) => {
        for (let i = 0; i + 1 < c.pts.length; i++) {
          const [ax, ay] = c.pts[i], [bx, by] = c.pts[i + 1];
          if (x >= ax && x <= bx) return ay + (by - ay) * (x - ax) / (bx - ax);
        }
        return c.pts[c.pts.length - 1][1];
      };
      const ly = lead ? lineY(lead.x) : c.pts[c.pts.length - 1][1];
      const p = price(ly), chg = (p - 1) * 100, upNow = chg >= 0;
      g.setLineDash([4, 4]); g.lineWidth = 1;
      g.strokeStyle = upNow ? 'rgba(54,179,104,0.7)' : 'rgba(224,71,59,0.7)';
      g.beginPath(); g.moveTo(xL, ly); g.lineTo(xR - 64, ly); g.stroke(); g.setLineDash([]);
      g.fillStyle = upNow ? '#1f9d57' : '#c9302c';
      g.beginPath(); g.roundRect(xR - 66, ly - 10, 62, 20, 4); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center';
      g.fillText(p.toFixed(4), xR - 35, ly + 4);

      // Ticker. The pair is invented on purpose: real tickers are other
      // people's trademarks.
      g.textAlign = 'left';
      g.font = '700 14px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.fillStyle = 'rgba(244, 241, 237, 0.9)';
      g.fillText(c.pair, xL + 12, yTop + 22);
      g.fillStyle = upNow ? '#36B368' : '#E0473B';
      g.fillText(`${upNow ? '▲ +' : '▼ '}${chg.toFixed(2)}%`, xL + 112, yTop + 22);
      g.font = '600 11px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.fillStyle = 'rgba(219, 213, 208, 0.5)';
      g.fillText(c.mode === 'moon' ? '1m · PUMPING' : c.mode === 'crash' ? '1m · VOLATILE' : '1m · DUMPING', xL + 12, yTop + 40);

      // A parody news crawl along the foot of the chart. Every name in it is
      // invented: no real exchange, coin, regulator or person.
      const news = '  BREAKING: MRBL flips the market  ·  Whale moves 10,000 MRBL to cold storage  ·  ' +
        'Analysts confirm marbles are round  ·  Marble Commission opens inquiry into suspiciously round asset  ·  ' +
        'Influencer: "this is financial advice" (it is not)  ·  Degens report record gm count  ·  ' +
        'MRBL hash rate hits all-time high  ·  Local marble "not selling", says marble  ·';
      g.save();
      g.beginPath(); g.rect(xL, yBot - 22, xR - xL, 22); g.clip();
      g.fillStyle = 'rgba(224,71,59,0.85)';
      g.fillRect(xL, yBot - 22, 78, 22);
      g.fillStyle = 'rgba(12,16,28,0.9)';
      g.fillRect(xL + 78, yBot - 22, xR - xL - 78, 22);
      g.font = '600 12px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.textAlign = 'left';
      const tw = g.measureText(news).width, off = (this.clock * 70) % tw;
      g.fillStyle = 'rgba(244, 241, 237, 0.85)';
      g.save(); g.beginPath(); g.rect(xL + 78, yBot - 22, xR - xL - 78, 22); g.clip();
      g.fillText(news, xL + 84 - off, yBot - 7);
      g.fillText(news, xL + 84 - off + tw, yBot - 7);
      g.restore();
      g.fillStyle = '#fff'; g.font = '700 11px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.fillText('MRBL NEWS', xL + 8, yBot - 7);
      g.restore();
    });
    g.lineWidth = 10;
    g.textAlign = 'center';
  }

  /** Called by the page for each warp event, since events are per tick. */
  onWarp(ev) { (this.warpQueue = this.warpQueue || []).push(ev); }

  /**
   * A white or grey hole.
   *
   * White: a bright core with rays turning OUTWARD, the opposite of the black
   * hole's inward ring, and a "+2" tag. Grey: the same shape, drawn white while
   * it points forward and dark while it points back, with an arrow, the
   * section count, and a ring that empties as the current phase runs out, so
   * a viewer can see which way it is pointing AND when it is about to flip.
   */
  _warpHole(g, h) {
    const E = this.engine;
    const dir = E.holeDir(h);
    const fwd = dir > 0;
    const R = Math.max(h.eat, 22);
    const glow = fwd ? 'rgba(190, 232, 255, ' : 'rgba(120, 128, 150, ';

    // The rail it sweeps along, so a viewer can see where it will be.
    if (h.sway) {
      g.save();
      g.setLineDash([6, 10]);
      g.lineWidth = 2;
      g.strokeStyle = fwd ? 'rgba(190,232,255,0.28)' : 'rgba(168, 163, 157, 0.25)';
      g.beginPath(); g.moveTo(h.x0 - h.sway, h.y); g.lineTo(h.x0 + h.sway, h.y); g.stroke();
      g.restore();
    }

    const well = g.createRadialGradient(h.x, h.y, R, h.x, h.y, h.pull);
    well.addColorStop(0, glow + '0.22)');
    well.addColorStop(1, glow + '0)');
    g.fillStyle = well;
    g.beginPath(); g.arc(h.x, h.y, h.pull, 0, Math.PI * 2); g.fill();

    // Rays turning outward.
    const spin = -this.clock * 1.6;
    g.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
      const a = spin + (i * Math.PI) / 4;
      g.strokeStyle = fwd ? 'rgba(220,245,255,0.75)' : 'rgba(168, 163, 157, 0.6)';
      g.beginPath();
      g.moveTo(h.x + Math.cos(a) * (R + 4), h.y + Math.sin(a) * (R + 4));
      g.lineTo(h.x + Math.cos(a + 0.35) * (R + 22), h.y + Math.sin(a + 0.35) * (R + 22));
      g.stroke();
    }

    const core = g.createRadialGradient(h.x, h.y, 0, h.x, h.y, R);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.6, fwd ? '#bfe8ff' : '#6b6661');
    core.addColorStop(1, fwd ? 'rgba(120,200,255,0.2)' : 'rgba(51, 47, 44, 0.4)');
    g.fillStyle = core;
    g.beginPath(); g.arc(h.x, h.y, R, 0, Math.PI * 2); g.fill();

    if (h.kind === 'grey') {
      // Ring: how much of this phase is left.
      const into = ((E.tick + h.phase) % h.half) / h.half;
      g.lineWidth = 4;
      g.strokeStyle = fwd ? '#bfe8ff' : '#aba6a1';
      g.beginPath();
      g.arc(h.x, h.y, R + 30, -Math.PI / 2, -Math.PI / 2 + (1 - into) * Math.PI * 2);
      g.stroke();
    }

    // Direction and size, in words a bettor can read: seconds, not sections.
    const n = Math.abs(fwd ? h.ahead.secs : h.behind.secs);
    g.font = '700 14px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.fillStyle = fwd ? '#dff4ff' : '#ccc9c5';
    g.fillText(`${fwd ? '▼ +' : '▲ −'}${n}s`, h.x, h.y + R + 52);
    g.lineWidth = 10;
  }

  /**
   * A black hole, live or collapsed.
   *
   * Live: a faint well showing the reach of the pull, a hot accretion ring
   * turning around a pure black core. The ring is what tells a viewer this is
   * dangerous before anything has been eaten. Collapsed (the knockout cap was
   * reached): a grey dome, deliberately dull, so the change is legible.
   */
  _hole(g, h, armed) {
    if (!armed) {
      g.beginPath();
      g.arc(h.x, h.y, h.core, 0, Math.PI * 2);
      g.fillStyle = '#443D36';
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = '#787067';
      g.stroke();
      g.lineWidth = 10;
      return;
    }
    // Drawn at a fixed size: the horizon was made smaller to make knockouts
    // rarer, and the picture should not shrink with it.
    h = { ...h, eat: Math.max(h.eat, 22) };
    const well = g.createRadialGradient(h.x, h.y, h.eat, h.x, h.y, h.pull);
    well.addColorStop(0, 'rgba(150, 90, 255, 0.20)');
    well.addColorStop(0.45, 'rgba(90, 50, 200, 0.07)');
    well.addColorStop(1, 'rgba(60, 30, 160, 0)');
    g.fillStyle = well;
    g.beginPath();
    g.arc(h.x, h.y, h.pull, 0, Math.PI * 2);
    g.fill();

    // Accretion ring: a few arcs at different radii turning at different
    // speeds, hot on the inside.
    const spin = this.clock;
    for (let i = 0; i < 4; i++) {
      const r = h.eat + 10 + i * 9;
      const a0 = spin * (2.6 - i * 0.45) + i * 1.7;
      g.beginPath();
      g.arc(h.x, h.y, r, a0, a0 + Math.PI * 1.25);
      g.strokeStyle = ['#ffd9a0', '#ff9f43', '#c86bff', '#6b5bff'][i];
      g.globalAlpha = 0.85 - i * 0.16;
      g.lineWidth = 4 - i * 0.6;
      g.stroke();
    }
    g.globalAlpha = 1;

    const core = g.createRadialGradient(h.x, h.y, 0, h.x, h.y, h.eat + 6);
    core.addColorStop(0, '#000');
    core.addColorStop(0.8, '#000');
    core.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(h.x, h.y, h.eat + 6, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 10;
  }

  /**
   * A racer, drawn as a COIN: milled rim, metallic face in the racer's colour,
   * an embossed symbol, and a glint. The face turns with the marble's roll.
   *
   * The designs are ORIGINAL on purpose. Real coin logos and names belong to
   * other organisations, and printing them on racers in a betting product
   * would imply an endorsement nobody gave. The first attempt used each
   * racer's initial with a double bar, and on Bullion's gold coin that is,
   * to anyone looking, the Bitcoin mark; Blaze got the same one. So each
   * racer has its own EMBLEM instead, from the pattern it already carries:
   * flame, snowflake, droplet, crown, ingot. Distinct at a glance, and
   * nobody's trademark.
   */
  _marble(g, m, trail) {
    const d = this.racers[m.index];
    const dark = DARK[m.index % DARK.length];
    const r = m.r;

    for (let i = 0; i < trail.length; i++) {
      g.globalAlpha = (i / trail.length) * 0.22;
      g.fillStyle = d.hex;
      g.beginPath();
      g.arc(trail[i].x, trail[i].y, r * 0.58, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // Rim.
    g.fillStyle = dark;
    g.beginPath(); g.arc(m.x, m.y, r, 0, Math.PI * 2); g.fill();

    const a = this.rot ? this.rot[m.index] || 0 : 0;
    g.save();
    g.translate(m.x, m.y);
    g.rotate(a);

    // Milled edge. Always light: Bullion's accent is a dark brown, and its
    // milling vanished into its own rim.
    g.strokeStyle = '#ffffff';
    g.globalAlpha = 0.5;
    g.lineWidth = 1.4;
    g.beginPath();
    for (let k = 0; k < 20; k++) {
      const t = (k / 20) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      g.moveTo(c * r * 0.84, s * r * 0.84); g.lineTo(c * r * 0.98, s * r * 0.98);
    }
    g.stroke();
    g.globalAlpha = 1;

    // Face.
    const face = g.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r * 0.82);
    face.addColorStop(0, '#ffffff');
    face.addColorStop(0.3, d.hex);
    face.addColorStop(1, dark);
    g.fillStyle = face;
    g.beginPath(); g.arc(0, 0, r * 0.8, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(0, 0, r * 0.66, 0, Math.PI * 2); g.stroke();

    // Embossed emblem.
    g.fillStyle = 'rgba(15, 18, 30, 0.72)';
    g.strokeStyle = 'rgba(15, 18, 30, 0.72)';
    emblem(g, d.pattern, r * 0.5);
    g.restore();

    // Glint, fixed to the light, not to the face.
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.beginPath();
    g.ellipse(m.x - r * 0.38, m.y - r * 0.42, r * 0.24, r * 0.12, -0.7, 0, Math.PI * 2);
    g.fill();
  }
}

const DARK = ['#8e2a14', '#12527a', '#166b38', '#4a2b9e', '#7a5806'];

/**
 * A racer's coin emblem, centred at the origin, `s` about its half-size.
 * Plain paths, so it looks the same everywhere and needs no font.
 */
function emblem(g, kind, s) {
  g.beginPath();
  switch (kind) {
    case 'flame':                                  // Blaze
      g.moveTo(0, -s);
      g.bezierCurveTo(s * 0.9, -s * 0.2, s * 0.8, s * 0.8, 0, s);
      g.bezierCurveTo(-s * 0.8, s * 0.8, -s * 0.9, 0, -s * 0.2, -s * 0.4);
      g.bezierCurveTo(-s * 0.1, 0, s * 0.1, -s * 0.3, 0, -s);
      g.fill();
      break;
    case 'orbit':                                  // Frost: a snowflake
      g.lineWidth = s * 0.28;
      g.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI) / 3, c = Math.cos(a) * s, n = Math.sin(a) * s;
        g.moveTo(-c, -n); g.lineTo(c, n);
      }
      g.stroke();
      break;
    case 'venom':                                  // Venom: a droplet
      g.moveTo(0, -s);
      g.bezierCurveTo(s * 0.4, -s * 0.3, s * 0.8, s * 0.1, s * 0.8, s * 0.35);
      g.arc(0, s * 0.35, s * 0.8, 0, Math.PI);
      g.bezierCurveTo(-s * 0.8, s * 0.1, -s * 0.4, -s * 0.3, 0, -s);
      g.fill();
      break;
    case 'crown':                                  // Royal
      g.moveTo(-s, s * 0.6);
      g.lineTo(-s, -s * 0.5);
      g.lineTo(-s * 0.45, s * 0.05);
      g.lineTo(0, -s * 0.8);
      g.lineTo(s * 0.45, s * 0.05);
      g.lineTo(s, -s * 0.5);
      g.lineTo(s, s * 0.6);
      g.closePath();
      g.fill();
      break;
    default:                                       // Bullion: an ingot
      g.moveTo(-s * 0.6, -s * 0.45);
      g.lineTo(s * 0.6, -s * 0.45);
      g.lineTo(s, s * 0.5);
      g.lineTo(-s, s * 0.5);
      g.closePath();
      g.fill();
  }
}
