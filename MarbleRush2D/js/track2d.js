// track2d.js: The section library, and seeded assembly of a course from it.
//
// This is the part that answers "hand-designing each section is a mess".
//
// A 3D section had to emit swept meshes AND a matching collision
// representation, in deck-local coordinates, on a deck that might be running
// either direction, with winding and handedness both able to betray you. A 2D
// section emits LINE SEGMENTS and CIRCLES into a y-band. That is the whole
// contract. You can read a section's geometry off the screen and change it
// without a solver surprising you.
//
// Adding a section is: write one function, add one line to SECTIONS. It is
// then in the random pool and benchable on its own with
//
//   node MarbleRush2D/tools/simulate2d.js --only pegs --races 5
//
// COORDINATES. The course is authored in a fixed 800-wide world and scaled to
// the window at draw time, so a section never has to care about screen size.
// Inside a section, `y` is measured from the TOP OF THAT SECTION, so a section
// can be moved up or down the course without touching its numbers.
//
// THE ONE RULE. Never close the full width. Every horizontal line across a
// section must have an opening of at least MIN_GAP, or the field arrives at a
// wall and the race never finishes. Gravity is the only thing pushing marbles
// along, so a section cannot ask them to climb, either.

import { MARBLE_DATA } from '../../js/racers.js';
import { SECTION_STATS } from './sectionStats.js';
import { dsin, dcos } from './engine2d.js';

// The course is built from the seed in Node AND in every browser, so it must come out the same to the last bit.
// Math.sin, Math.cos and Math.hypot are not specified to the bit: Chrome 154 and Node 24 round some inputs one
// ulp apart, which moved a few walls by 1e-16 and, a minute into a long race, put the browser's marbles in a
// different place from the server's. dsin/dcos and a plain sqrt are exact arithmetic, identical everywhere.
const hyp = (x, y) => Math.sqrt(x * x + y * y);

export const TRACK_W = 800;
export const WALL_L  = 40;
export const WALL_R  = 760;

/**
 * Probe overrides for section tunables. EMPTY in the game.
 *
 * The bench tools set this to sweep a value without rewriting source, which is
 * both faster and safer: an earlier sweep that rewrote the file with a regex
 * corrupted it. A section reads `TUNE.<id>?.<name> ?? <default>`, so nothing
 * changes unless a tool asks.
 */
export const TUNE = {
  // WEAR, on by default (2026-09-26, 1000 races each, same seeds): leader at
  // 50/75/90% of the course goes on to win 40/57/72% without it, 34/50/63%
  // with it; field spread at 75% 15.7s -> 12.5s; lead changes after halfway
  // 3.8 -> 4.9. Each element is biggest or slowest for the FIRST marble to
  // reach it and gives way a step per marble after, never past a floor.
  // Physical and order-of-arrival only: nothing reads race position.
  // Tools switch it off with TUNE='{"wear":{}}'.
  wear: {
    flip: { grow: 140, step: 40, boost: 1.25 },     // pinball flippers: 310 long -> 170, throw 1.25x -> 1x
    pop: { grow: 10, step: 3 },                     // pop bumpers: r +10, -3 per marble
    hold: { extra: 0.5, step: 0.125 },              // fuses, claws, freezes: +0.5s first, -0.125s each after
    gate: { up: 0.6, step: 0.3, min: 0.5 },         // lasers, cups, hatches: closed spell x1.6 first, -0.3 each, floor x0.5
    // From halfway, holds and gate closed spells wear from up to 4x the
    // first-marble extra, cut per element so no first-marble wait passes
    // 2.5s (Sanjay's ceiling). 1000 races, same seeds, leader at 25/50/75/90%
    // goes on to win: 30/36/48/61% without, 24/28/38/49% with; lead changes
    // after halfway 5.2 -> 6.3.
    late: { from: 0.5, k: 4, cap: 2.5 },
  },
};

/**
 * How far a white or grey hole moves a marble, and the course's typical pace,
 * used to say it in seconds. PACE is measured: the median over 30 full-length
 * races was 304 world units per second.
 */
export const PACE = 300;

/**
 * Blocks in a race. 56 gives a median of about 3.5 minutes (the advisor asked
 * for 3-4): measured, 50 blocks ran a median 190s and 60 ran 227s.
 */
export const COURSE_BLOCKS = 58;
export const WARP_UNITS = 900;

/** A marble is 32 across. Nothing may narrow a passage below this. */
export const MIN_GAP = 96;
const TAU_ = 6.283185307179586;

/* ------------------------------ the context ---------------------------- */

function makeCtx(out, baseY, rng, section = 0) {
  return {
    W: TRACK_W, wallL: WALL_L, wallR: WALL_R, MIN_GAP, rng,

    /**
     * A wall. Coordinates are section-local in y, world in x.
     * `opts.layer` makes it solid to one layer only; `opts.boost` makes it a
     * dash pad that sets a touching marble's velocity. Both are for loops.
     */
    seg(ax, ay, bx, by, opts) {
      const s = { ax, ay: ay + baseY, bx, by: by + baseY };
      if (opts) Object.assign(s, opts);
      // Reversing belts: every conveyor flips direction on its own beat.
      if (s.belt && TUNE.belts?.flip && !s.flip) {
        const half = Math.round(240 * rng.range(TUNE.belts.lo ?? 0.8, TUNE.belts.hi ?? 1.4));
        s.flip = { half, phase: Math.floor(rng() * 2 * half) };
      }
      // A wearing gate (see timedGateOpen) counts marbles past this height.
      if (s.gate && s.gate.wear && s.gate.wy === undefined) s.gate.wy = Math.max(s.ay, s.by);
      // A sliding door's range is section-local too.
      if (s.door) s.door = { ...s.door, y0: s.door.y0 + baseY, y1: s.door.y1 + baseY };
      out.segments.push(s);
    },

    /** A lethal box: a marble whose centre falls into it while hazards are live is out. */
    pit(x0, y0, x1, y1, name = 'Fall') {
      out.pits.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1),
                      y0: y0 + baseY, y1: y1 + baseY, name });
    },

    /**
     * An opening in a side wall, y0..y1 section-local, `side` -1 left. The
     * wall is built around it; a pit box just outside takes any marble that
     * goes through while hazards are live, and a barrier closes it after.
     */
    opening(side, y0, y1, name = 'Edge') {
      out.openings.push({ side, y0: y0 + baseY, y1: y1 + baseY });
      const x0 = side < 0 ? 0 : WALL_R + 2, x1 = side < 0 ? WALL_L - 2 : TRACK_W;
      out.pits.push({ x0, x1, y0: y0 + baseY, y1: y1 + baseY, name });
      const wx = side < 0 ? WALL_L : WALL_R;
      out.segments.push({ ax: wx, ay: y0 + baseY, bx: wx, by: y1 + baseY, safe: true, net: true });
    },

    /**
     * A holding area in front of a timed floor: a marble waiting there is
     * WAITING, not stuck, so the stuck-marble nudge leaves it alone while the
     * floor is shut. `gate` is the floor's timing.
     */
    hold(x0, y0, x1, y1, gate) {
      out.holds.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1),
                       y0: y0 + baseY, y1: y1 + baseY, gate });
    },

    /**
     * A windmill: `arms` arms of `len` turning about (x, y) at `rps`
     * revolutions per second (negative: anticlockwise on screen). Its whole
     * swept disc must leave MIN_GAP to the walls, or an arm can pin a
     * marble against one.
     */
    rotor(x, y, len, { arms = 2, rps = 0.5, fr = 7, rest, phase } = {}) {
      if (x - len - fr < WALL_L + MIN_GAP - 20 || x + len + fr > WALL_R - MIN_GAP + 20) {
        console.warn(`[track2d] windmill at x=${x.toFixed(0)} len ${len} sweeps too close to a wall; skipped.`);
        return;
      }
      out.rotors.push({ cx: x, cy: y + baseY, len, arms, fr, rest,
                        w: (rps * TAU_) / 240, phase: phase ?? rng() * TAU_, angle: 0, section });
      // The hub is a peg, so a marble landing dead centre is thrown off it.
      out.bumpers.push({ x, y: y + baseY, r: 14, rest: 0.5, flashes: false, hub: true });
    },

    /** A bumper that glides between (ax, ay) and (bx, by) every `secs`. */
    mover(ax, ay, bx, by, { r = 16, secs = 2.4, rest, phase, kind } = {}) {
      const period = Math.round(secs * 240);
      out.movers.push({ ax, ay: ay + baseY, bx, by: by + baseY, r, rest, period, kind,
                        phase: phase ?? Math.floor(rng() * period), x: ax, y: ay + baseY, vx: 0, vy: 0, section });
    },

    /**
     * A box that acts on marbles inside it: kind 'fan' (fx, fy push), 'cryo'
     * (2s freeze, once per marble) or 'brake' (speed camera, vmax/keep).
     * `cycle` {on, off} seconds switches it on and off from the race clock,
     * at a seeded phase.
     */
    zone(kind, x0, y0, x1, y1, opts = {}) {
      const z = { kind, x0: Math.min(x0, x1), x1: Math.max(x0, x1),
                  y0: Math.min(y0, y1) + baseY, y1: Math.max(y0, y1) + baseY, section, ...opts };
      if (opts.ty !== undefined) z.ty = opts.ty + baseY;          // reorg destination
      if (opts.cy !== undefined) z.cy = opts.cy + baseY;          // a gravity well's centre
      if (opts.pulse) {                                           // a pulse well's curve, seconds -> ticks
        const P = opts.pulse;
        z.pulse = { rise: Math.round(P.rise * 240), hold: Math.round(P.hold * 240), end: Math.round(P.end * 240),
                    step: P.step, floor: P.floor };
      }
      if (opts.lo !== undefined) { z.lo = Math.round(opts.lo * 240); z.hi = Math.round(opts.hi * 240); }
      if (opts.cycle) {
        const on = Math.round(opts.cycle.on * 240), period = on + Math.round(opts.cycle.off * 240);
        z.cycle = { on, period, phase: Math.floor(rng() * period) };
      }
      // A SWINGING wind: blows fx for `swing` seconds, then -fx, and back.
      if (opts.swing) {
        const half = Math.round(opts.swing * 240);
        z.swing = { half, phase: Math.floor(rng() * 2 * half) };
      }
      out.zones.push(z);
    },

    /**
     * A cannon. A marble reaching the breech at (x, y) is loaded, held
     * `delay` seconds at the muzzle (mx, my), and fired at (vx, vy).
     */
    cannon(x, y, mx, my, vx, vy, { delay = 0.6, delayHi, catchR = 34, teleport, kind, gap = 60, refire } = {}) {
      out.cannons.push({ x, y: y + baseY, mx, my: my + baseY, vx, vy, catch: catchR,
                         delay: Math.round(delay * 240), delayHi: delayHi ? Math.round(delayHi * 240) : 0,
                         teleport, kind, gap, refire, section });
    },

    /** A price chart's drawing data (candles, volume, axis): renderer only. */
    chart(c) {
      out.charts.push({ ...c, pts: c.pts.map(([x, y]) => [x, y + baseY]),
                        pads: c.pads.map(([a, b, c2, d]) => [a, b + baseY, c2, d + baseY]), section });
    },

    /** A safety-car hold area; returns its index for the floor segments. */
    regroup(x0, y0, x1, y1, timeout, need) {
      out.regroups.push({ x0, x1, y0: y0 + baseY, y1: y1 + baseY, timeout, need, section });
      return out.regroups.length - 1;
    },

    /** A painted sign on the course, for drawing only. */
    sign(x, y, text, style = 'info') {
      out.signs.push({ x, y: y + baseY, text, style, section });
    },

    /** Mark a region as OFF THE TRACK, for drawing only (a detour lane). */
    offtrack(x0, y0, x1, y1) {
      out.offtrack.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: y0 + baseY, y1: y1 + baseY });
    },

    /** Layer switch: a marble whose centre enters the box takes `layer`. */
    sensor(x0, y0, x1, y1, layer) {
      out.sensors.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1),
                         y0: y0 + baseY, y1: y1 + baseY, layer });
    },

    /** A polyline arc of walls, `a0` to `a1` radians, screen angles (y down). */
    arc(cx, cy, R, a0, a1, opts, step = 0.16) {
      const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / step));
      let px = cx + dcos(a0) * R, py = cy + dsin(a0) * R;
      for (let i = 1; i <= n; i++) {
        const a = a0 + (a1 - a0) * (i / n);
        const x = cx + dcos(a) * R, y = cy + dsin(a) * R;
        this.seg(px, py, x, y, opts);
        px = x; py = y;
      }
    },
    /**
     * Lay out n obstacles across the deck with EVERY gap at least MIN_GAP.
     *
     * Pass the half-widths; get back the centre x of each. The spare room is
     * shared out between the n+1 gaps with seeded weights, so rows still look
     * irregular while the invariant holds by construction.
     *
     * Rolling your own with `span * (i+1) + rng.spread(34)` does not hold it:
     * three 58-wide wedges across 720 leaves 93 per gap before any jitter, and
     * the jitter then closed neighbouring pairs to 64, or overlapped them
     * outright. The V between two facing wedges caught a marble in a fifth of
     * all races, and it is invisible on the section bench because it needs a
     * particular seed to line up.
     */
    place(halfs) {
      const n = halfs.length;
      const need = halfs.reduce((a, h) => a + 2 * h, 0) + (n + 1) * MIN_GAP;
      const slack = (WALL_R - WALL_L) - need;
      if (slack < 0) {
        console.warn(`[track2d] place() cannot fit ${n} obstacles and keep ` +
                     `MIN_GAP: short by ${(-slack).toFixed(0)}. Use fewer or smaller.`);
        return [];
      }
      const w = halfs.map(() => rng()).concat(rng());
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      const out = [];
      let x = WALL_L;
      for (let i = 0; i < n; i++) {
        x += MIN_GAP + (slack * w[i]) / sum;
        out.push(x + halfs[i]);
        x += 2 * halfs[i];
      }
      return out;
    },

    /**
     * A tilted island: a capsule, not a circle.
     *
     * `len` is the flat span between the two end caps and `r` their radius, so
     * the long axis measures len + 2r. `angle` tilts it off horizontal, give
     * it one, because an untilted capsule has a long flat top that is just as
     * good a perch as a circle's apex.
     */
    island(x, y, r, len, angle, extra) {
      const hx = dcos(angle) * len / 2, hy = dsin(angle) * len / 2;
      out.capsules.push({ ...(extra || {}),
        ax: x - hx, ay: y + baseY - hy,
        bx: x + hx, by: y + baseY + hy,
        // mu 0: see dome() below; the same stuck zone sits on the upper cap.
        r, rest: 0.14, mu: 0,
      });
    },

    /**
     * A dome: a big, soft, round obstacle the field flows AROUND.
     *
     * The reference build has these as black hemispheres sitting on the board
     * (video 57s). Seen from above, which is what this whole view is, a
     * tilted board from overhead, a hemisphere is just a large circle, so it
     * is a peg with the bounce taken out. Convex, so it has no pocket.
     */
    dome(x, y, r = 46) {
      // FRICTIONLESS, deliberately. Friction here is Coulomb, which gives any
      // convex top a small STATIC zone: a marble rests wherever the surface is
      // flatter than mu, which on a 50-unit dome is a band ~4 units either
      // side of the crown. A marble dropping in from a centred exit lands in
      // it often enough to make this the worst stall in the library over a
      // long race. A real marble on a hemisphere rolls off; with mu 0 only the
      // exact crown balances, and nothing lands on an exact point.
      this.peg(x, y, r, { rest: 0.12, mu: 0, flashes: false });
    },

    /**
     * A round bumper: high restitution, and the cheapest way to shuffle.
     *
     * CLEARANCE IS ENFORCED HERE, because this is the one mistake that has now
     * cost us twice. A peg near a side wall leaves a pocket bounded by the peg,
     * the wall and whatever is below, and a marble that rolls in does not come
     * out. The 3D build needed the same clearance rule for obstacles near the
     * rails; the 2D version reproduced it within an hour of the library
     * existing, with a peg whose edge left 29.7 against a 32 marble.
     *
     * Refusing the peg is deliberate. Clamping it would quietly bunch a row
     * against the limit and change a section without saying so.
     */
    peg(x, y, r = 14, opts = {}) {
      const lo = WALL_L + r + MIN_GAP, hi = WALL_R - r - MIN_GAP;
      if (x < lo || x > hi) {
        console.warn(`[track2d] peg at x=${x.toFixed(1)} r=${r} leaves less than ` +
                     `MIN_GAP (${MIN_GAP}) to a wall; skipped. Keep it within ` +
                     `${lo.toFixed(0)}..${hi.toFixed(0)}.`);
        return;
      }
      // No two pegs so close that a marble cannot pass between them: that is
      // a V, and a marble resting in it is a DNF, because every rescue nudge
      // lets it fall straight back in. Refused, like the wall clearance.
      const wy = y + baseY;
      const tight = out.bumpers.find(b => {
        const need = b.r + r + 2 * 16 + 6;
        return (b.x - x) ** 2 + (b.y - wy) ** 2 < need * need;
      });
      if (tight) {
        console.warn(`[track2d] peg at (${x.toFixed(0)}, ${y.toFixed(0)}) is too close to the peg at ` +
                     `(${tight.x.toFixed(0)}, ${(tight.y - baseY).toFixed(0)}) for a marble to pass; skipped.`);
        return;
      }
      // WEAR on pop bumpers (rest above 1, the arcade ones): start `grow`
      // bigger and lose `step` of radius for each marble that hits it, never
      // below r. The grown size must pass the same two clearance rules, so
      // `grow` is cut down until it does, never the peg moved.
      const W = (opts.rest ?? 0) > 1 ? TUNE.wear?.pop : null;
      let grow = W?.grow ?? 0;
      const fits = (R) => x >= WALL_L + R + MIN_GAP && x <= WALL_R - R - MIN_GAP &&
        !out.bumpers.some(b => (b.x - x) ** 2 + (b.y - wy) ** 2 < (b.r + R + 38) ** 2);
      while (grow > 0 && !fits(r + grow)) grow -= 2;
      // Ramps and pads are checked once the whole section is built (see
      // buildTrack), since some are drawn after the peg.
      if (grow > 0) out.bumpers.push({ x, y: wy, r, flash: 0, ...opts, growWant: grow, wearStep: W.step });
      else out.bumpers.push({ x, y: wy, r, flash: 0, ...opts });
    },
    /**
     * A ring wall with angular gaps, colliding only from the inside.
     * `gaps` are { angle, half } in radians; -PI/2 is the top, +PI/2 the floor.
     */
    bowl(x, y, R, gaps) {
      // Each gap also carries its direction and the cosine of its half-width,
      // computed here ONCE, so the engine can test "is the marble in a gap"
      // with a dot product instead of calling atan2 every tick.
      const g = gaps.map(p => ({ ...p, cx: dcos(p.angle), cy: dsin(p.angle),
                                 cosHalf: dcos(p.half) }));
      out.bowls.push({ x, y: y + baseY, R, gaps: g });
    },

    /**
     * A black hole. `eat` is the event horizon (marble CENTRE inside it is
     * gone), `pull` how far the attraction reaches, `k` its strength, `core`
     * the solid dome it collapses into once hazards disarm.
     *
     * The dormant core must itself be a legal obstacle, so the same wall
     * clearance as a peg is enforced here: a hole is only ever harmless or
     * lethal, never a pocket.
     */
    /**
     * A pinball flipper hinged on a side wall. `side` -1 is the left wall.
     *
     * Angles are measured DOWN from horizontal, pointing into the course:
     * `rest` is where it lies waiting, `up` where the stroke ends. Converted to
     * unit directions HERE, once, so the engine never calls a trig function.
     */
    flipper(side, y, opts = {}) {
      const len = opts.len ?? 170, fr = opts.fr ?? 9;
      const rest = opts.rest ?? 0.50, up = opts.up ?? 0.02;
      const px = side < 0 ? WALL_L : WALL_R;
      const dir = (a) => ({ x: -side * dcos(a), y: dsin(a) });
      const r = dir(rest), u = dir(up);
      // WEAR (Sanjay): a flipper starts `grow` longer and loses `wear` of
      // length for every marble it throws, never below `len`. The first
      // marbles to arrive meet the big one; the ones behind meet what is left.
      const W = TUNE.wear?.flip || {};
      const grow = opts.grow ?? W.grow ?? 0, wear = opts.wear ?? W.step ?? 0;
      // How much harder (tip speed) the full-size flipper throws than a
      // standard one; it falls to 1 as the flipper wears down.
      const boost = W.boost ?? 1.25;
      out.flippers.push({ px, py: y + baseY, len: len + grow, min: len, wear, fr, side, boost,
                          rx: r.x, ry: r.y, ux: u.x, uy: u.y });
    },

    /**
     * A spring pad from (ax, ay) to (bx, by), firing at `power` along its
     * UPPER normal. It is also a wall, so it can stand in for a piece of ramp.
     */
    spring(ax, ay, bx, by, opts = {}) {
      const dx = bx - ax, dy = by - ay, l = Math.sqrt(dx * dx + dy * dy);
      let nx = -dy / l, ny = dx / l;
      if (ny > 0) { nx = -nx; ny = -ny; }          // the face that points up
      out.springs.push({ ax, ay: ay + baseY, bx, by: by + baseY, nx, ny,
                         base: opts.base ?? 420, gain: opts.gain ?? 0.55 });
    },

    hole(x, y, opts = {}) {
      const core = opts.core ?? 30;
      const sway = opts.sway ?? 0;
      const lo = WALL_L + core + MIN_GAP, hi = WALL_R - core - MIN_GAP;
      if (x - sway < lo || x + sway > hi) {
        console.warn(`[track2d] hole at x=${x.toFixed(1)} leaves less than MIN_GAP to a wall; skipped.`);
        return;
      }
      out.holes.push({
        x, y: y + baseY, core,
        kind: opts.kind ?? 'black',
        eat:  opts.eat  ?? 30,
        pull: opts.pull ?? 260,
        k:    opts.k    ?? 2.0e7,
        soft: opts.soft ?? 900,
        name: opts.name ?? 'Black hole',
        // Grey: the forward/back cycle. Destinations (WARP_UNITS either way)
        // are resolved once the whole course exists.
        half: opts.half ?? 720, phase: opts.phase ?? 0,
        // A sweeping hole: x0 is the middle of the sweep, the engine moves x.
        x0: x, sway, swayPeriod: opts.swayPeriod ?? 960, swayPhase: opts.swayPhase ?? 0,
        section,
      });
    },
  };
}

/**
 * Three big windmills close together (four for the Wind Farm), after
 * Antigravity's version, which Sanjay rightly said did the job better: arms
 * long enough to span most of the course, so no marble falls past on the
 * side without meeting one. My first pair were 210 across and slow: marbles
 * slipped round them, swapping 1.3 pairs in 10 with the leader still in front
 * 72% of the time. Measured by tools/shuffle2d.js, this one swaps 2.5 in 10
 * (a peg field 2.0), leader kept 53-63%. Faster and bouncier arms are what
 * did it; more arms did not. An arm coming round bats a marble up and back,
 * one going away lets it drop, and which it meets is timing.
 */
function windmillSection(ctx, rng, fourth) {
  const T = TUNE.windmills || {};
  const dir = rng() < 0.5 ? 1 : -1, rps = T.rps ?? 0.8, rest = T.rest ?? 0.85;
  ctx.seg(WALL_L, 20, 250, 100);
  ctx.seg(WALL_R, 20, 550, 100);
  ctx.rotor(400, 270, 165, { arms: 2, rps: rps * dir, fr: 8, rest });
  ctx.rotor(250, 600, 120, { arms: 2, rps: -rps * 1.2 * dir, fr: 8, rest });
  ctx.rotor(550, 600, 120, { arms: 2, rps: rps * 1.2 * dir, fr: 8, rest });
  if (fourth) ctx.rotor(400, 880, 150, { arms: 2, rps: rps * 1.1 * dir, fr: 8, rest });
  const f = fourth ? 300 : 0;
  ctx.seg(WALL_L, 790 + f, 336, 940 + f);
  ctx.seg(WALL_R, 790 + f, 464, 940 + f);
}

/**
 * THE CHART, rebuilt (2026-09-25). Sanjay: it did not look like a chart, and
 * nothing happened on it. The old one was a line that only ever fell, because
 * a real rally is an uphill, and gravity alone cannot get a marble up one.
 *
 * So now there are PUMPS. At the foot of every rally sits a booster pad that
 * launches a marble up it, and its strength swings on its own beat (the
 * market's volatility): hit it strong and you clear the top and fly; hit it
 * weak and you stall, roll back onto the pad, and go again. Where you come
 * out depends on WHEN you hit each pump, which is the reshuffle. A pad fires
 * every time it is touched, so no rally can ever hold a marble for good.
 *
 * The line runs left to right, the way time runs on a chart, with rallies
 * (green) and dips (red), and the renderer draws the candles, volume, grid and
 * a live price on it.
 *
 *   moon   rallies outgrow the dips: the price climbs across the section
 *   dump   dips outgrow the rallies: dead-cat bounces on the way down
 *   crash  a dump with a TRAPDOOR candle in it that drops open on a beat:
 *          fall through and you skip the rest of the chart
 */
function chartSection(ctx, rng, mode) {
  const T = TUNE.chart || {};
  const moon = mode === 'moon';
  // The line starts 50 in from the wall with a short lead-in: a pump
  // starting AT the wall made a corner a marble could wedge in.
  const legs = 4, x0 = WALL_L + 50, x1 = 650, w = (x1 - x0) / legs;
  let y = moon ? 560 : 170;
  ctx.seg(WALL_L, y - 25, x0, y);
  // Entry: everything to the left, onto the start of the chart.
  // The dump's entry was 8 degrees from the wall corner: a marble bounced
  // into that corner crept rather than rolled (a third of chart nudges).
  if (moon) ctx.seg(WALL_R, 20, 200, 150);
  else ctx.seg(WALL_R, 20, 150, 140);
  const pts = [[x0, y]], pads = [];
  // A moon rally rises up to 85, which takes ~505 at the foot: a pump at 330
  // could not clear it, the marble rolled back into the pump, and rocked
  // there until the loiter rescue. Moon pumps start at 600, so every pump
  // clears; WHEN you hit it still decides how fast.
  const pumpLo = T.lo ?? (moon ? 600 : 330), pumpHi = T.hi ?? (moon ? 900 : 820);
  const trap = mode === 'crash' ? 1 + Math.floor(rng() * 2) : -1;
  for (let i = 0; i < legs; i++) {
    const xa = x0 + i * w;
    // A leg is a rally (pad at its foot) then a dip, or for the dump a dip
    // then a rally. Rise and drop are seeded, the rally always the steeper.
    const rise = moon ? rng.range(55, 85) : rng.range(28, 48);
    const drop = moon ? rng.range(18, 36) : rng.range(80, 120);
    const rallyW = w * (moon ? 0.62 : 0.4), dipW = w - rallyW;
    const rally = (xs, ys) => {
      const xe = xs + rallyW, ye = ys - rise;
      const L = hyp(rallyW, rise), ux = rallyW / L, uy = -rise / L;
      const pl = 34;                                   // the pad: the rally's first 34 units
      const period = Math.round(240 * rng.range(0.8, 1.4));
      ctx.seg(xs, ys, xs + ux * pl, ys + uy * pl, {
        chart: 'pump', boost: { ux, uy, pulse: { lo: pumpLo, hi: pumpHi, period, phase: Math.floor(rng() * period) } } });
      ctx.seg(xs + ux * pl, ys + uy * pl, xe, ye, { chart: 'up' });
      pads.push([xs, ys, xs + ux * pl, ys + uy * pl]);
      pts.push([xe, ye]);
      return [xe, ye];
    };
    const dip = (xs, ys, isTrap) => {
      const xe = xs + dipW, ye = ys + drop;
      if (isTrap) {
        const period = Math.round(240 * rng.range(1.0, 1.4));
        const gate = { period, open: 70, phase: Math.floor(rng() * period), label: 'FLASH CRASH' };
        ctx.seg(xs, ys, xe, ye, { chart: 'down', gate, tray: true, crash: true });
      } else ctx.seg(xs, ys, xe, ye, { chart: 'down' });
      pts.push([xe, ye]);
      return [xe, ye];
    };
    let p = [xa, y];
    if (moon) { p = rally(p[0], p[1]); p = dip(p[0], p[1], false); }
    else { p = dip(p[0], p[1], i === trap); p = rally(p[0], p[1]); }
    y = p[1];
  }
  // Off the end of the chart and down the right-hand side.
  ctx.seg(WALL_L, 700, 336, 800);
  ctx.seg(WALL_R, 700, 464, 800);
  ctx.chart({ pts, pads, mode, pair: 'MRBL/USDC' });
}

/**
 * A peg board laid out as a WORD (GM, HODL, WAGMI). A 3x5 pixel font, one
 * peg per lit pixel, every peg at least `step` from the next so a marble can
 * always pass (the peg() guard enforces it anyway). A little seeded jitter,
 * so no crown sits dead under the centre line.
 */
const FONT = {
  G: ['111', '100', '101', '101', '111'], M: ['101', '111', '101', '101', '101'],
  H: ['101', '101', '111', '101', '101'], O: ['111', '101', '101', '101', '111'],
  D: ['110', '101', '101', '101', '110'], L: ['100', '100', '100', '100', '111'],
  W: ['101', '101', '101', '111', '101'], A: ['010', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
};
function pegWords(ctx, rng, lines, step, r) {
  ctx.seg(WALL_L, 20, 240, 100);
  ctx.seg(WALL_R, 20, 560, 100);
  let y = 150;
  for (const word of lines) {
    const cols = word.length * 4 - 1;
    const x0 = 400 - (cols - 1) * step / 2;
    [...word].forEach((ch, k) => {
      FONT[ch].forEach((row, j) => [...row].forEach((bit, i) => {
        if (bit === '1') ctx.peg(x0 + (k * 4 + i) * step + rng.spread(1.5), y + j * step, r, { word: true });
      }));
    });
    y += 5 * step + 60;
  }
  ctx.seg(WALL_L, y, 336, y + 150);
  ctx.seg(WALL_R, y, 464, y + 150);
}

/**
 * One loop fork (the Loop the Loop), `y0` down the section, loop on the left
 * unless `flip`. Shared by the Loop the Loop and the Loop Row.
 */
function loopFork(ctx0, rng, y0, flip) {
  const ctx = shiftCtx(ctx0, y0);
  const X = (x) => flip ? TRACK_W - x : x;
  const s = (ax, ay, bx, by, o) => ctx.seg(X(ax), ay, X(bx), by, o);

  const T = TUNE.loop || {};
  const cx = 250, R = 105, floor = 600, cy = floor - R;
  const L0 = { layer: 0 }, L1 = { layer: 1 };

  // Funnel onto the fork dome.
  s(WALL_L, 40, 340, 150);
  s(WALL_R, 40, 460, 150);
  ctx.dome(400, 215, 18);
  s(400, 232, 400, 720);                           // the divider

  // Loop branch.
  s(385, 250, 150, 330);                           // back towards the wall
  s(WALL_L, 360, 120, 540, L0);                    // entry, steep
  s(120, 540, 150, 578, L0);                       // ...curving level
  s(150, 578, 185, 597, L0);
  s(185, 597, 200, 600, L0);
  s(200, 600, 245, 600, { layer: 0, boost: { vx: (flip ? -1 : 1) * (T.boost ?? 1150), vy: 0 } });

  // The ring. Screen angles: +PI/2 is the bottom, 0 the right, -PI/2 the
  // top. Travel is bottom -> right -> top -> left -> bottom. Mirroring
  // x reverses that sense, which is exactly what the mirrored copy wants.
  const ring = (a0, a1, o) => {
    if (!flip) { ctx.arc(cx, cy, R, a0, a1, o); return; }
    ctx.arc(TRACK_W - cx, cy, R, Math.PI - a0, Math.PI - a1, o);
  };
  ring(Math.PI / 2, 0, L0);                        // lower right: in
  ring(0, -Math.PI, undefined);                    // over the top: both
  ring(Math.PI, Math.PI / 2, L1);                  // lower left: out
  ctx.sensor(X(215), cy - R - 10, X(285), cy - R + 40, 1);

  s(250, 600, 290, 606, L1);                       // exit floor
  ctx.sensor(X(280), 650, X(398), 780, 0);         // back to layer 0

  // Plain branch: two ramps.
  s(400, 300, 640, 380);
  s(WALL_R, 460, 520, 560);

  // Merge.
  s(WALL_L, 760, 340, 900);
  s(WALL_R, 760, 460, 900);
}

/** The same context, `dy` further down the section. */
function shiftCtx(ctx, dy) {
  return {
    ...ctx,
    seg: (ax, ay, bx, by, o) => ctx.seg(ax, ay + dy, bx, by + dy, o),
    arc: (cx, cy, R, a0, a1, o, step) => ctx.arc(cx, cy + dy, R, a0, a1, o, step),
    sensor: (x0, ya, x1, yb, layer) => ctx.sensor(x0, ya + dy, x1, yb + dy, layer),
    dome: (x, y, r) => ctx.dome(x, y + dy, r),
    peg: (x, y, r, o) => ctx.peg(x, y + dy, r, o),
  };
}

/**
 * One layout for all three holes.
 *
 * The field is funnelled into a stream that passes CLOSE to one side of the
 * hole. Most marbles are slung, not taken: the near side of the stream is
 * whipped round and thrown across the course, the far side barely bends.
 * Which side a marble is on is decided by the bumping in the funnel, so it is
 * chaos rather than lane. The hole sits off the drop line by a seeded amount
 * and to a seeded side, so no grid lane is ever systematically closer to it.
 *
 *   black  swallows the marble: knocked out (see MAX_OUT in the engine)
 *   white  sends it about 3 seconds AHEAD: Sanjay's idea, the good twin
 *   grey   sends it about 3 seconds ahead OR back, on a visible cycle
 */
function holeSection(ctx, rng, kind) {
  const T = (kind === 'black' ? TUNE.blackhole : kind === 'white' ? TUNE.whitehole : TUNE.greyhole) || {};

  // A PEG FIELD, not a funnel, above the hole. The first version funnelled
  // the field into a stream past the hole, and a funnel does not spread
  // marbles: every one left the mouth at the same point moving the same way,
  // so it was ONE stream. Whether the hole took nobody or took everybody then
  // depended only on which side of that stream it sat, which is decided by
  // the course, not by the race: a white hole warped all five marbles in 38
  // races of 120 and none in 73. (The black hole had the same flaw, hidden by
  // its two-knockout cap.) Staggered pegs put every marble on its own line,
  // so capture is a per-marble event.
  //
  // And the field is turned OFF THE WALLS first. Pegs keep MIN_GAP from each
  // wall, which leaves a clear corridor down both sides, and a field that
  // arrived against a wall fell straight down that corridor, past every peg,
  // all five on one line and nowhere near the hole.
  ctx.seg(WALL_L, 20, 230, 90);
  ctx.seg(WALL_R, 20, 570, 90);
  for (let row = 0; row < 3; row++) {
    const y = 150 + row * 90;
    const n = row % 2 === 0 ? 4 : 3;
    const span = row % 2 === 0 ? 140 : 150;
    const x0 = 400 - (span * (n - 1)) / 2 + rng.spread(10);
    for (let i = 0; i < n; i++) ctx.peg(x0 + i * span, y, 13);
  }

  // The hole, off-centre by a seeded amount to a seeded side.
  // Tuned on full-length courses, 100 races: with one white and one grey hole
  // in every race (sometimes a third), about half of all races see a warp,
  // spread like a real per-marble chance (1 warp: 35%, 2: 13%, 3: 5%). The
  // black hole is much rarer, a knockout in ~12% of its appearances, because
  // it costs a bettor everything where a warp only costs or gains ~3s.
  const side = rng() < 0.5 ? -1 : 1;
  const warp = kind !== 'black';
  // White and grey holes SWEEP across the course (see Engine2D.swayAt), so
  // they sit at the middle and the sweep does the rest. The black hole stays
  // put, off the drop line by a seeded amount: a moving killer would be a
  // lottery nobody could read.
  const hx = warp ? 400 + rng.spread(20) : 400 + side * rng.range(T.lo ?? 100, T.hi ?? 180);
  // Tuned on full courses, 120 races, by what Sanjay saw: a white hole that
  // a fast marble flew straight through. Standing still with a 30-unit
  // horizon it caught 12% of marbles overall, 5% of the fastest, and was
  // visibly SMALLER than its own rays. Sweeping with an 80 horizon, drawn at
  // exactly that size: 31% of marbles, fast ones 27%, and flat by race
  // position (leader 36%, last 33%), so it is nobody's bonus in particular.
  // The pull is kept weak: a strong one is what made capture depend on speed.
  const d = { black: [13, 6e6], white: [80, 1.5e6], grey: [80, 1.5e6] }[kind];
  ctx.hole(hx, 600, {
    kind,
    eat: T.eat ?? d[0], k: T.k ?? d[1], pull: T.pull ?? 240,
    sway: warp ? (T.sway ?? 200) : 0,
    swayPeriod: Math.round(240 * rng.range(T.plo ?? 5, T.phi ?? 7)),
    swayPhase: Math.floor(rng() * 2000),
    name: { black: 'Black hole', white: 'White hole', grey: 'Grey hole' }[kind],
    // Grey: 3 seconds each way, starting at a seeded point in the cycle.
    half: 720, phase: Math.floor(rng() * 1440),
  });

  // A soft deflector low down turns slung marbles back towards the centre,
  // so the exit funnel is not simply taken by whoever was thrown hardest.
  ctx.dome(400 - side * 170, 860, 34);

  // Exit funnel, generous: after a slingshot the field arrives from every
  // angle at once.
  ctx.seg(WALL_L, 900, 336, 1060);
  ctx.seg(WALL_R, 900, 464, 1060);
}

/**
 * The Gatehouse, and its rare lethal twin The Breach. Sanjay's idea.
 *
 * The field comes off a slide straight at a DOORWAY in a divider, with a
 * sliding door that never stops moving, rising and falling. Where the door is
 * at the instant a marble arrives decides it: blocked, the marble drops down
 * the short way; through, it is off the track, into a lane behind the divider
 * that costs it about 1.5-2 seconds before it merges back.
 *
 * A time penalty, not a knockout, because it is in every race: the door has
 * to be open long enough to SEE, and every marble passes it, so as a knockout
 * it would take a marble in most races.
 *
 * The Breach is the knockout version, drawn rarely from the knockout pool.
 * Its off-track lane runs past a SECOND moving door, in the course's real
 * outer wall. A marble that finds both doors open flies off the course. Two
 * bad-luck timings in a row keep it rare.
 *
 * Door cycles start at seeded points, so no grid lane is ever timed into them.
 * Mirrored by a seeded coin.
 */
function gateSection(ctx, rng, lethal) {
  const T = (lethal ? TUNE.breach : TUNE.gatehouse) || {};
  const flip = rng() < 0.5;
  const X = (x) => flip ? TRACK_W - x : x;
  const s = (ax, ay, bx, by, o) => ctx.seg(X(ax), ay, X(bx), by, o);
  const div = 290;                                     // the divider
  const side = flip ? 1 : -1;

  // Everything onto the slide, and off its end at the doorway.
  s(WALL_L, 20, 330, 110);
  s(WALL_R, 60, 360, 300);                             // the slide
  s(div, 130, div, 250);                               // divider above the doorway
  // The door: 100 long, sliding up behind the divider and back down.
  const period = T.period ?? 720;                      // 3s up and down
  s(div, 250, div, 350, { door: { y0: 250, y1: 350, len: 100, period,
                                  phase: Math.floor(rng() * period) } });
  s(div, 350, div, 700);                               // divider below it

  // Short way: straight down and across.
  s(div, 470, 660, 560);

  // The off-track lane: zig-zags, then back in. Measured: three rows cost a
  // diverted marble ~1.05s, four ~1.5s (Sanjay asked for 1.5-2s).
  ctx.offtrack(X(WALL_L), 130, X(div), 700);
  let rows = T.rows ?? [[370, 1], [465, -1], [560, 1], [650, -1]];

  if (lethal) {
    // The lane's first ramp runs TOWARDS the outer wall and ends at a short
    // lip, so a marble coming through the doorway carries across the last
    // stretch into the course's real side wall, where there is a second
    // moving door. Diverted marbles in the Gatehouse layout never reached the
    // outer wall at all: its first ramp runs them away from it.
    //
    // The outer door lifts only PART of its height (travel < len), opening a
    // slot at its foot for a short part of each cycle.
    s(div, 380, 150, 432);
    s(150, 432, 125, 436);
    const oy0 = T.oy0 ?? 400, oy1 = T.oy1 ?? 480;
    ctx.opening(side, oy0, oy1, 'Breach');
    const wx = side < 0 ? WALL_L : WALL_R;
    const op = T.outerPeriod ?? 600;
    ctx.seg(wx, oy0, wx, oy1, { door: { y0: oy0, y1: oy1, len: oy1 - oy0,
                                         travel: T.travel ?? 40, period: op,
                                         phase: Math.floor(rng() * op) } });
    rows = T.rows ?? [[540, 1], [640, -1]];
  }
  for (const [y, dir] of rows) {
    if (dir > 0) s(WALL_L, y, 180, y + 55);
    else         s(div, y, 150, y + 55);
  }

  // Merge.
  s(WALL_L, 740, 336, 870);
  s(WALL_R, 740, 464, 870);
}

/* ---------------------------- the library ------------------------------ */
//
// Each entry: id, label (shown on the course), len (how much height it takes),
// and build(ctx, rng).

export const SECTIONS = [
  {
    id: 'chutes',
    label: 'The Grooves',
    len: 1120,
    build(ctx, rng) {
      // Alternating ramps. Each one runs the field across the full width and
      // drops it off the open end onto the next, which runs back the other
      // way. The open end is what makes it passable, and it is deliberately
      // wide: this is the section the field arrives at cold, straight off the
      // grid, and a tight entry there bunches everyone into one corner.
      // Pitch matters more than it looks. A ramp only moves a marble when its
      // gradient beats the rolling resistance, and these were 120 over 580, // shallow enough that the whole field parked on the first one.
      const rows = 5, drop = 215, fall = 175;
      for (let i = 0; i < rows; i++) {
        const y = 40 + i * drop;
        const slack = rng() * 60;
        if (i % 2 === 0) ctx.seg(WALL_L, y, 600 - slack, y + fall);
        else             ctx.seg(WALL_R, y, 200 + slack, y + fall);
      }
    },
  },
  {
    id: 'pegs',
    label: 'Validator Nodes',
    len: 1080,
    build(ctx, rng) {
      // A staggered peg field. Bumpers are the arcade element and they are
      // what genuinely mixes the order, a marble's exit lane depends on
      // which side of a peg it clipped, which is chaotic but not arbitrary.
      // Four per row, not five. The legal band for a 14-radius peg is
      // 150..650 once MIN_GAP is kept clear of both walls, which is 500 wide, // five at 130 spacing needs 520 and pushed the outer peg into the wall
      // pocket. Rows alternate their offset so a marble never sees a clear
      // vertical corridor.
      const rows = 8, gapY = 125, span = 140;
      for (let row = 0; row < rows; row++) {
        const y = 60 + row * gapY;
        const off = (row % 2 === 0 ? 162 : 220) + rng.spread(8);    // jitter stays inside 150..650
        for (let i = 0; i < 4; i++) ctx.peg(off + i * span, y, 14, { node: true });
      }
    },
  },
  {
    id: 'bowl',
    label: 'The Bowl',
    len: 980,
    build(ctx, rng) {
      // The vortex with a centre drain, and the reason it is worth building:
      // it is the ONLY element in the library that reverses places rather than
      // merely spreading the field. Whoever finds the drain first wins the
      // exchange regardless of who arrived first.
      //
      // The exit gap sits off-centre by a seeded amount, so the bowl does not
      // become a memorised "hug the left wall" solution.
      const cx = 400, cy = 440, R = 300;

      // A HOPPER over the entrance, and an ISLAND under it.
      //
      // The entrance has to sit directly above the drain, because the drain
      // must contain the bowl floor or marbles settle on solid wall. So on its
      // own this ring is just a hole: the field falls in one gap and out the
      // other without touching the wall, and the block meant to be the big
      // reshuffler does nothing.
      //
      // The ISLAND is what fixes that, not the feed. Everything entering meets
      // it and is deflected into the annulus. That leaves the two walls with
      // one job, gathering the full width into the opening, which is why a
      // plain funnel is the right shape here.
      //
      // Two failed attempts are worth recording. Ending the feed INSIDE the
      // ring made it cross the wall: on screen a stick through the bowl, and a
      // segment end hard against the wall for a marble to wedge on. Replacing
      // it with two long opposed diagonals kept them outside but still read as
      // crossed sticks. Both ends below sit just clear of R and inside the
      // entrance arc, and stop at different heights so the feed is not
      // perfectly symmetrical.
      //
      // Measured: 100% of marbles reach the wall, mean travel ~197 degrees.
      ctx.seg(WALL_L, 25, cx - 70, 140);   // funnel, left wall
      ctx.seg(WALL_R, 25, cx + 80, 130);   // funnel, right wall (ends higher)

      // THE DRAIN MUST CONTAIN THE BOTTOM OF THE BOWL. A marble loses speed to
      // friction and settles at the lowest point; if the gap has been offset
      // far enough that the lowest point is solid wall, it rests there and the
      // race never ends. So the offset is strictly smaller than the half-width,
      // and the bowl floor is inside the drain for every seed.
      const DRAIN_HALF = 0.34;
      const exit = rng.spread(DRAIN_HALF * 0.55);
      ctx.bowl(cx, cy, R, [
        { angle: -Math.PI / 2, half: 0.42 },                 // entrance, top
        { angle:  Math.PI / 2 + exit, half: DRAIN_HALF },    // drain, floor
      ]);
      // An island, or this is not a bowl at all, it is a hole.
      //
      // The entrance is directly above the drain (it has to be: the drain must
      // contain the bowl floor or marbles settle on solid wall). Without
      // something in the middle the field simply falls through the ring from
      // one gap to the other, never touching it, and the block that is
      // supposed to be the big reshuffler does nothing. The island forces the
      // field out into the annulus and around.
      // Tilted, so the field cannot perch on it. Long axis 150 + 2*86 = 322,
      // which still leaves 139 of annulus at its ends against MIN_GAP 96.
      ctx.island(cx, cy, 86, 150, rng.range(0.55, 1.05));

      // The exit chute must CONTINUE the ring from the gap edges, not cross
      // it. Starting the walls 20 inside the radius put their top ends in the
      // bowl interior, and the corner between a ring and a segment end is a
      // pocket: a marble rolls in and does not come out. That single detail
      // was every DNF in a 300-race sweep, 25 races that could not be
      // settled, and nothing else in the library failed at all.
      //
      // Anchoring to the gap edge angles also makes the chute exactly as wide
      // as the drain, so it cannot pinch below MIN_GAP.
      const a0 = Math.PI / 2 + exit - DRAIN_HALF;
      const a1 = Math.PI / 2 + exit + DRAIN_HALF;
      const e0x = cx + dcos(a0) * R, e0y = cy + dsin(a0) * R;
      const e1x = cx + dcos(a1) * R, e1y = cy + dsin(a1) * R;
      ctx.seg(e0x, e0y, e0x, cy + R + 170);
      ctx.seg(e1x, e1y, e1x, cy + R + 170);
    },
  },
  {
    id: 'splitter',
    label: 'The Fork',
    len: 900,
    build(ctx, rng) {
      // A centre wedge splits the field into two channels that rejoin below.
      // Neither side is faster by design; which side a marble takes is decided
      // by where it happens to arrive, so it separates the field cheaply
      // without deciding the race on its own.
      const apex = 400 + rng.spread(40);
      // Rounded nose. A bare vertex is a point the field arrives at dead-on,
      // and "which side did it take" then turns on a hair. A radius makes the
      // split read as a deflection rather than a knife edge, and a circle has
      // no corner for a marble to balance on.
      const r = 30, cy = 60 + r;
      for (const s of [-1, 1]) {
        const dx = s * 210, dy = 370, l = hyp(dx, dy);
        ctx.seg(apex + (dx / l) * r, cy + (dy / l) * r, apex + dx, 430);
      }
      ctx.dome(apex, cy, r);
      ctx.seg(apex - 210, 430, apex - 150, 560);
      ctx.seg(apex + 210, 430, apex + 150, 560);
      ctx.peg(apex, 640, 18);
      ctx.seg(WALL_L, 700, 300, 800);
      ctx.seg(WALL_R, 700, 500, 800);
    },
  },
  {
    id: 'stairs',
    label: 'The Cascade',
    len: 1000,
    build(ctx, rng) {
      // Short offset ledges. Each drop is small, so this is where the field
      // rolls rather than falls, it rewards carried speed and is the closest
      // thing in the library to the wooden run in the reference video.
      const steps = 7;
      for (let i = 0; i < steps; i++) {
        const y = 50 + i * 130;
        const left = i % 2 === 0;
        const w = 330 + rng.spread(40);
        if (left) ctx.seg(WALL_L, y, WALL_L + w, y + 78);
        else      ctx.seg(WALL_R, y, WALL_R - w, y + 78);
      }
    },
  },
  {
    id: 'sprint',
    label: 'Final Sprint',
    len: 940,
    build(ctx, rng) {
      // Long shallow deflectors. Little mixing, lots of speed: this is the
      // run-in, and it is where a late charger can close a gap.
      const lanes = 3;
      for (let i = 0; i < lanes; i++) {
        const y = 150 + i * 300;
        const t = rng.spread(50);
        if (i % 2 === 0) ctx.seg(WALL_R, y, 420 + t, y + 90);
        else             ctx.seg(WALL_L, y, 380 + t, y + 90);
      }
    },
  },

  /* ------------------------------------------------------------------ *
   * Below here: blocks read off the reference video.                    *
   * Timestamps are into marble.mp4; re-extract with                     *
   *   swift tools/frames.swift marble.mp4 <dir> 3 0 60                  *
   * ------------------------------------------------------------------ */

  {
    id: 'combs',
    label: 'Comb Grooves',
    len: 780,
    // Video 24s: straight parallel grooves routed into a plank, like a comb.
    // A SORTER, it does not spread the field so much as commit each marble
    // to a lane, and which lane it takes is decided in the half second it
    // spends at the mouth.
    build(ctx, rng) {
      const N = 5;
      const w = (WALL_R - WALL_L) / N;          // 144, comfortably over MIN_GAP
      const mouth = 150, len = 420;

      // Funnel down from the full width so nothing is left outside a channel.
      ctx.seg(WALL_L, 30, WALL_L + w * 0.5, mouth);
      ctx.seg(WALL_R, 30, WALL_R - w * 0.5, mouth);

      for (let i = 1; i < N; i++) {
        const x = WALL_L + i * w + rng.spread(10);
        ctx.seg(x, mouth, x, mouth + len);
        // Round the divider tip. A bare segment end is a flat spot a marble
        // can sit on; a circle is at worst an unstable balance that any
        // sideways speed rolls off.
        ctx.dome(x, mouth, 13);
      }
    },
  },

  {
    id: 'serpent',
    label: 'The Serpentine',
    len: 1180,
    // Video 21s: the deep S-wave channel carved into a plank. One shared
    // channel, so the whole field is forced into single file and has to
    // overtake inside the bends instead of simply spreading out.
    build(ctx, rng) {
      const A = 60, P = 500, half = 78;         // channel 156 wide
      // A sine bends tightest at R = P^2/(4*pi^2*A). Parallel curves FOLD
      // where that drops below the offset, which is the trap that capped the
      // 3D version of this block at one lazy S. 105 against 78 here.
      const R = (P * P) / (4 * Math.PI * Math.PI * A);
      if (R <= half) console.warn(`[track2d] serpent folds: R ${R.toFixed(0)} <= half ${half}`);

      const y0 = 150, y1 = 1120, steps = 60;
      const phase = rng.spread(30);
      // COSINE, so the channel opens at a peak where the curve is momentarily
      // straight. Starting on a sine zero puts the mouth at the steepest lean
      // in the whole block, and the field meets it side-on.
      const cx = (y) => 400 + A * dcos(((y - y0) / P) * Math.PI * 2) + phase;

      // Build the wall points FIRST, then attach the funnel to where the walls
      // actually begin.
      //
      // The offset is along the NORMAL, offsetting in x would narrow the
      // channel to width*cos(theta) on every lean, which is what jammed the 3D
      // grooves solid, and a normal has a y component too. So the wall does
      // NOT start at y0: it starts wherever the normal puts it, which here was
      // 47 above y0. Aiming the funnel at y0 left the wall poking up through
      // it, and the V between the two swallowed the field.
      const L = [], Rr = [];
      for (let i = 0; i <= steps; i++) {
        const y = y0 + ((y1 - y0) * i) / steps;
        const x = cx(y);
        const yb = y0 + ((y1 - y0) * Math.max(0, i - 1)) / steps;
        const yf = y0 + ((y1 - y0) * Math.min(steps, i + 1)) / steps;
        const dx = cx(yf) - cx(yb), dy = yf - yb;
        const l = hyp(dx, dy) || 1;
        const nx = dy / l, ny = -dx / l;
        L.push([x - nx * half, y - ny * half]);
        Rr.push([x + nx * half, y + ny * half]);
      }
      for (let i = 1; i <= steps; i++) {
        ctx.seg(L[i - 1][0], L[i - 1][1], L[i][0], L[i][1]);
        ctx.seg(Rr[i - 1][0], Rr[i - 1][1], Rr[i][0], Rr[i][1]);
      }
      ctx.seg(WALL_L, 20, L[0][0], L[0][1]);
      ctx.seg(WALL_R, 20, Rr[0][0], Rr[0][1]);
    },
  },

  {
    id: 'wedges',
    label: 'Wedge Field',
    len: 940,
    // Video 09s and 36s: loose triangular blocks scattered down an open slope.
    // Free-standing and convex, so there is no pocket anywhere, a marble
    // that touches one is always deflected, never held.
    build(ctx, rng) {
      const rows = 4;
      for (let r = 0; r < rows; r++) {
        const y = 110 + r * 210;
        const n = r % 2 === 0 ? 3 : 2;
        const halfs = Array.from({ length: n }, () => 40 + rng() * 14);   // <=54: 3 must fit with MIN_GAP
        const xs = ctx.place(halfs);
        for (let i = 0; i < xs.length; i++) {
          const x = xs[i];
          const hw = halfs[i], h = 52 + rng() * 14;
          // Apex uphill, ROUNDED, and no base.
          //
          // The bare apex was a point marbles balanced on, 22 stalls in 10
          // seeds, all at that one vertex. And a closed triangle is a box: a
          // marble that ever gets inside it cannot leave. Leaving the downhill
          // side open means gravity empties the shape by itself, which is a
          // better guarantee than hoping nothing gets in.
          const r = 15, cy = y + r;
          for (const s of [-1, 1]) {
            const dx = s * hw, dy = h - r, l = hyp(dx, dy);
            ctx.seg(x + (dx / l) * r, cy + (dy / l) * r, x + dx, y + h);
          }
          ctx.dome(x, cy, r);
        }
      }
    },
  },

  {
    id: 'humps',
    label: 'The Humps',
    len: 900,
    // Video 57s: black hemispheres sitting on the board. From overhead, and
    // overhead on a tilted board is exactly this view, a hemisphere is a big
    // soft circle. Convex, so they deflect without ever trapping.
    build(ctx, rng) {
      const rows = 4;
      for (let r = 0; r < rows; r++) {
        const y = 130 + r * 200;
        const n = r % 2 === 0 ? 2 : 3;
        // Two overlapping circles meet in a CUSP, which is as good a trap as
        // any V. Same guaranteed spacing as the wedges.
        const halfs = Array.from({ length: n }, () => 42 + rng() * 12);   // <=54: 3 must fit with MIN_GAP
        ctx.place(halfs).forEach((x, i) => ctx.dome(x, y, halfs[i]));
      }
    },
  },

  {
    id: 'gauntlet',
    label: 'The Rails',
    len: 860,
    // Video 15s: two clear rods laid down the slope forming a narrow run.
    // The field has to queue, and the jostling at the mouth is where places
    // change, inside the chute there is no room to pass.
    build(ctx, rng) {
      const cx = 400 + rng.spread(70);
      const half = 55;                          // 110 clear, over MIN_GAP
      const mouth = 190, len = 430;

      ctx.seg(WALL_L, 20, cx - half, mouth);
      ctx.seg(WALL_R, 20, cx + half, mouth);
      ctx.seg(cx - half, mouth, cx - half, mouth + len);
      ctx.seg(cx + half, mouth, cx + half, mouth + len);
      // Flare, so nobody clips a bare rail end on the way out.
      ctx.seg(cx - half, mouth + len, cx - half - 120, mouth + len + 120);
      ctx.seg(cx + half, mouth + len, cx + half + 120, mouth + len + 120);
    },
  },

  {
    id: 'spiral',
    label: 'The Spiral',
    len: 1020,
    // Video 42-48s: concentric rings routed into a board around a centre hole.
    //
    // Built as a containing ring with a raised island in the middle, which is
    // what it is: the ring holds the marble in, the island stops it settling
    // in the centre, so it has to travel around the annulus to find the drain.
    // Like the bowl this REVERSES places rather than just spreading the field.
    build(ctx, rng) {
      const cx = 400, cy = 470, R = 290;
      // Annulus must stay passable: 290 - 150 = 140 against MIN_GAP 96.
      // Same two-stage feed as the bowl but mirrored, so the field enters
      // moving RIGHT here and LEFT there.
      //
      // The old version ran one segment the full width one way and the next
      // the full width back again. They never actually intersected, but on
      // screen two long opposed diagonals over a ring read as crossed sticks.
      // A long delivery ramp with a short feeder above its high end reads as
      // a slide, which is what it is.
      ctx.seg(WALL_L, 25, cx - 80, 130);   // funnel, left wall (ends higher)
      ctx.seg(WALL_R, 25, cx + 70, 145);   // funnel, right wall

      const HALF = 0.32;
      const exit = rng.spread(HALF * 0.5);      // drain always contains the floor
      ctx.bowl(cx, cy, R, [
        { angle: -Math.PI / 2, half: 0.40 },
        { angle:  Math.PI / 2 + exit, half: HALF },
      ]);
      // Long axis 110 + 2*105 = 320; annulus at the ends 290 - 160 = 130.
      ctx.island(cx, cy, 105, 110, rng.range(0.5, 1.0));

      const a0 = Math.PI / 2 + exit - HALF, a1 = Math.PI / 2 + exit + HALF;
      ctx.seg(cx + dcos(a0) * R, cy + dsin(a0) * R, cx + dcos(a0) * R, cy + R + 150);
      ctx.seg(cx + dcos(a1) * R, cy + dsin(a1) * R, cx + dcos(a1) * R, cy + R + 150);
    },
  },
  {
    id: 'flippers',
    label: 'The Flippening',
    len: 1180,
    build(ctx, rng) {
      // Three stages, alternating walls. Each has a feed ramp that runs the
      // field towards a flipper on the far wall and drops it off the end.
      // Where a marble lands depends on how fast it left the ramp: short and
      // it lands on the flipper and is thrown back up and across the course;
      // long and it clears the tip and goes straight down. And a flipper that
      // has just fired is still recovering, so the marble behind gets through.
      //
      // The throw is aimed UP AND ACROSS, not straight up. A flipper hinged on
      // the wall and swung through the vertical throws straight up, and the
      // marble lands back on the same flipper: a loop with no exit. Ending the
      // stroke level keeps every throw leaning away from the wall.
      const T = TUNE.flippers || {};
      let side = rng() < 0.5 ? -1 : 1;           // wall the first flipper is on
      for (let i = 0; i < 3; i++) {
        const y0 = 60 + i * 370;
        // Feed from the OPPOSITE wall, dropping towards the flipper's wall.
        const feedEnd = 400 + side * (T.feed ?? 30) + rng.spread(20);
        if (side < 0) ctx.seg(WALL_R, y0, feedEnd, y0 + 95);
        else          ctx.seg(WALL_L, y0, feedEnd, y0 + 95);
        // No wear here: these already catch 68% at standard length, and a
        // grown one spread the field 7.8s -> 10.4s. Wear is for the pinball
        // tables, whose flippers caught 19%.
        ctx.flipper(side, y0 + 215, { len: T.len ?? 170, rest: T.rest ?? 0.5, up: T.up ?? 0.02, grow: 0, wear: 0 });
        side = -side;
      }
    },
  },
  {
    id: 'springs',
    label: '100x Leverage',
    len: 1260,
    build(ctx, rng) {
      // A field of trampolines FLOATING in open space, not set into a path.
      //
      // The first version set a pad into every ramp, so every marble crossed
      // every pad: 13-17 launches a race out of a possible 20. That is a
      // spectacle every marble shares, not an event that happens to some.
      // Here the field falls through open air past pads that cover about a
      // third of each row, so one marble hits three trampolines and the next
      // drops clean through without touching one. Sanjay's call.
      //
      // Each pad is tilted, by a seeded amount either way, so a launch throws
      // sideways as well as up, and how hard is set by how hard the marble
      // LANDED (see the engine's _spring). Every bounce differs, and always for
      // a reason a viewer can see.
      const T = TUNE.springs || {};
      const rows = 5, gapY = 210, half = T.half ?? 42;
      ctx.seg(WALL_L, 30, 300, 110);                  // spread the arrivals
      ctx.seg(WALL_R, 30, 500, 110);
      for (let r = 0; r < rows; r++) {
        const y = 220 + r * gapY;
        const n = r % 2 === 0 ? 3 : 2;
        for (const x of ctx.place(Array(n).fill(half))) {
          const tilt = (rng() < 0.5 ? -1 : 1) * rng.range(0.14, 0.30);
          const dx = dcos(tilt) * half, dy = dsin(tilt) * half;
          ctx.spring(x - dx, y - dy, x + dx, y + dy, { base: T.base ?? 420, gain: T.gain ?? 0.55 });
        }
      }
      ctx.seg(WALL_L, 1080, 336, 1220);               // collect
      ctx.seg(WALL_R, 1080, 464, 1220);
    },
  },
  {
    id: 'loop',
    label: 'Degen Loop',
    len: 960,
    build(ctx, rng) {
      // A FORK. A funnel drops the field onto a dome that sits on top of a
      // divider: bounce one way and you ride a full 360 loop, bounce the
      // other and you take a plain chute. The loop is the long way round, so
      // which side of the dome you strike is worth places.
      //
      // Written for a loop on the LEFT and mirrored by a seeded coin, so the
      // loop is not always on the same side of the course.
      //
      // HOW A LOOP WORKS IN 2D. A loop crosses its own path, so it is built on
      // two LAYERS. The entry ramp, the dash pad and the lower-right quarter
      // of the ring are layer 0; the lower-left quarter and the exit floor are
      // layer 1; the top half is solid to both. A sensor at the top of the
      // ring moves the marble to layer 1, so on the way down it passes clean
      // through the entry it came in on. A second sensor below the exit puts
      // it back on layer 0 for the rest of the course.
      loopFork(ctx, rng, 0, rng() < 0.5);
    },
  },
  {
    id: 'jump',
    label: 'The Jump',
    len: 1120,
    hazard: true,
    build(ctx, rng) {
      // A run-up, a kicker, a GAP, and a landing ramp on the far side. Clear
      // it and you are away; come up short and you drop into the pit and are
      // out. Once the knockout cap is reached a safety net is strung across
      // the gap and the whole field simply rolls over it.
      //
      // What decides it is speed at the lip, which depends on how cleanly a
      // marble came down the run-up, and in a bunch, who it was bumped by.
      // Mirrored by a seeded coin so the jump is not always left to right.
      const T = TUNE.jump || {};
      const flip = rng() < 0.5;
      const X = (x) => flip ? TRACK_W - x : x;
      const s = (ax, ay, bx, by, o) => ctx.seg(X(ax), ay, X(bx), by, o);

      // THE LIP IS LEVEL, and that is the whole design.
      //
      // Launched level, a marble falls the landing drop D in a fixed time,
      // sqrt(2D/g), so the distance it carries is proportional to its speed
      // and the gap width is a smooth dial on "how slow is too slow". The
      // first build launched DOWN the run-up's slope, and a marble launched
      // downward spends LESS time in the air the faster it goes: jump length
      // barely depended on speed at all, and the gap took nobody or took the
      // first two of every race.
      //
      // Speed at the lip then has to vary a little, and only rarely a lot.
      // The field drops onto the run-up through a short peg field, so where it
      // lands varies, and a long steep run after the pegs gives everyone most
      // of their speed. Peg field alone, with a short run, spread lip speed so
      // wide that a quarter of the field fell.
      const lipY = 400, lipX = 420;
      // Tuned on FULL-LENGTH courses, 100 races each, because neither the
      // section's own bench nor a short mini-course predicts it: in a long race
      // the field reaches the jump strung out and at speed. With the current
      // pegs, 78 takes a marble in ~16% of appearances (70: 19%, 100: 34%).
      const gap = T.gap ?? 78;
      const landX = lipX + gap, landY = lipY + (T.drop ?? 40);

      // Funnel onto the pegs, STEEP. Mid-course, marbles arriving on the right
      // crawled the whole length of a 7-degree wall and reached the run-up
      // with nothing left: the largest cause of knockouts behind the Grooves,
      // and not a jump at all.
      s(WALL_L, 10, 130, 95);
      s(WALL_R, 10, 230, 125);
      // Every peg clears the run-up below it by well over MIN_GAP: an earlier
      // layout left 36 units over a 32-unit marble, and it became a trap.
      // And clears the funnel's ends: at 30 units the first peg and the end of
      // the funnel wall held a marble between them.
      // And every pair of pegs clears each other: two at 205 and 275, jittered
      // towards each other, left 28 units between them for a 32-unit marble,
      // and held one there for the rest of a race (no nudge can free a marble
      // from a V it simply falls back into).
      // The right-hand peg sits well short of the curve: further right, it
      // threw marbles onto the curve just before the lip with no run left,
      // a floor of ~18% knockouts that no gap width could tune away.
      for (const [px, py] of T.pegs ?? [[158, 150], [270, 160], [215, 210]]) {
        ctx.peg(X(px + rng.spread(8)), py, 12);
      }
      // Steep run-up, then a curve down to level.
      // The curve reaches level AT the edge, with no flat after it. A 20-unit
      // flat lip was somewhere a slow marble could stop dead; the stall
      // rescue then nudged it, and the nudge dropped it in the pit. A
      // knockout caused by the rescue system is not a fair event.
      const run = [[WALL_L, 215], [320, 375], [345, 387], [370, 395], [395, 399], [lipX, 400]];
      for (let i = 1; i < run.length; i++) s(run[i - 1][0], run[i - 1][1], run[i][0], run[i][1]);

      const shaftEnd = lipY + 300;
      s(lipX, lipY, lipX, shaftEnd);                     // pit, near wall
      s(landX, landY, landX, shaftEnd);                  // pit, far wall
      s(landX, landY, WALL_R - 100, landY + 40);         // landing ramp
      // A roof over the gap, so nothing can drop in except off the lip. It
      // slopes AWAY from the lip: sloped towards it, it rolled anything that
      // landed on it onto the lip at a crawl, straight into the pit.
      s(lipX + 5, 250, WALL_R - 100, 330);
      // The pit has NO FLOOR. While armed a marble is taken by the box long
      // before the bottom. But one already falling when the cap is reached
      // must not land in a closed box; it drops out of the bottom and back
      // into the course instead.
      ctx.pit(X(lipX + 2), lipY + 40, X(landX - 2), shaftEnd - 10, 'Jump');
      // The net, only once hazards disarm. Lip to landing.
      s(lipX, lipY, landX, landY, { safe: true, net: true });

      // Back across and out. The return ramp passes a FULL MIN_GAP below the
      // ends of the pit walls: an earlier layout ran it into them and boxed
      // marbles in against the far wall of the shaft.
      s(WALL_R, shaftEnd + 90, 330, shaftEnd + 200);
      s(WALL_L, shaftEnd + 260, 336, shaftEnd + 380);
      s(WALL_R, shaftEnd + 260, 464, shaftEnd + 380);
    },
  },
  {
    id: 'edge',
    label: 'The Edge',
    len: 980,
    hazard: true,
    build(ctx, rng) {
      // A slide into a side wall with an OPENING in it. Sanjay's idea, and
      // the counterweight to the Jump: the Jump takes a marble that is too
      // SLOW, the Edge takes one that is too FAST. It carries straight off the
      // level lip and out through the opening, where a marble at ordinary
      // pace drops short of it into the catch below. So no one way of running
      // the course is reliably safest.
      //
      // Speed at the lip has to vary, so the field joins the slide through a
      // few pegs: land high and you have the whole slide to gather speed,
      // land low and you do not. The lip is LEVEL for the reason the Jump's
      // is: launched level, how far a marble carries is proportional to its
      // speed, so the opening's depth is a smooth dial on "how fast is too
      // fast". Mirrored by a seeded coin.
      const T = TUNE.edge || {};
      const flip = rng() < 0.5;
      const side = flip ? 1 : -1;
      const X = (x) => flip ? TRACK_W - x : x;
      const s = (ax, ay, bx, by, o) => ctx.seg(X(ax), ay, X(bx), by, o);

      const lipX = 230, lipY = 446;
      s(WALL_L, 20, 420, 110);                                   // onto the slide
      for (const [px, py] of [[620, 130], [520, 170], [430, 215]]) {
        ctx.peg(X(px + rng.spread(8)), py, 12);
      }
      const slide = [[WALL_R, 180], [300, 430], [275, 440], [250, 445], [lipX, 446]];
      for (let i = 1; i < slide.length; i++) s(slide[i - 1][0], slide[i - 1][1], slide[i][0], slide[i][1]);

      // The opening, from just above lip height down to the dial. Measured
      // mid-course, 200 races each: 25 took a marble in 10% of appearances
      // behind the Grooves and 2.5% behind the Spiral; 35 took 34% and 5%.
      ctx.opening(side, lipY - 30, lipY + (T.depth ?? 26), 'Edge');

      // Catch everything that dropped short and send it on.
      s(WALL_L, 650, 600, 750);
      s(WALL_R, 800, 464, 930);
      s(WALL_L, 800, 336, 930);
    },
  },
  {
    id: 'gatehouse',
    label: 'The Gatehouse',
    len: 900,
    build: (ctx, rng) => gateSection(ctx, rng, false),
  },
  {
    id: 'breach',
    label: 'The Breach',
    len: 900,
    hazard: true,
    build: (ctx, rng) => gateSection(ctx, rng, true),
  },
  {
    id: 'chart',
    label: 'To the Moon',
    len: 820,
    build: (ctx, rng) => chartSection(ctx, rng, 'moon'),
  },
  {
    id: 'dump',
    label: 'The Dump',
    len: 860,
    build: (ctx, rng) => chartSection(ctx, rng, 'dump'),
  },
  {
    id: 'flashcrash',
    label: 'Flash Crash',
    len: 860,
    build: (ctx, rng) => chartSection(ctx, rng, 'crash'),
  },
  // ------------------------------------------------------------------
  // THE 2026-09-25 LIBRARY. Sanjay: the course repeated itself too often
  // and after halfway the race was over. These add new MACHINES (windmills,
  // fans, cryo traps, speed cameras, conveyors, cannons, moving bumpers) as
  // well as new layouts, and every one is measured by tools/drama2d.js for
  // how much it SHUFFLES a field and how much it SPREADS one.
  // ------------------------------------------------------------------
  {
    id: 'windmills',
    label: 'Windmills',
    len: 980,
    build: (ctx, rng) => windmillSection(ctx, rng, false),
  },
  {
    id: 'windfarm',
    label: 'Wind Farm',
    len: 1280,
    build: (ctx, rng) => windmillSection(ctx, rng, true),
  },
  {
    id: 'turbine',
    label: 'The Turbine',
    len: 820,
    build(ctx, rng) {
      // One big four-arm rotor right under a funnel mouth, like a turnstile.
      // Marbles queue into it and each is let through by an arm: the order it
      // lets them out in is not the order they came in.
      const dir = rng() < 0.5 ? 1 : -1;
      ctx.seg(WALL_L, 20, 300, 170);
      ctx.seg(WALL_R, 20, 500, 170);
      ctx.rotor(400, 330, 140, { arms: 4, rps: 0.3 * dir, fr: 8 });
      ctx.peg(190, 470, 12);
      ctx.peg(610, 470, 12);
      ctx.seg(WALL_L, 620, 336, 780);
      ctx.seg(WALL_R, 620, 464, 780);
    },
  },
  {
    id: 'hashmill',
    label: 'Hash Mill',
    len: 880,
    build(ctx, rng) {
      const V = ctx.v;
      // Four small rotors in a diamond, all at different speeds: a grinder.
      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      const sp = () => (rng() < 0.5 ? -1 : 1) * rng.range(V.lo ?? 0.5, V.hi ?? 0.9);
      const arms = V.arms ?? 3, rest = V.rest;
      ctx.rotor(400, 220, 70, { arms, rps: sp(), rest });
      ctx.rotor(260, 390, 70, { arms, rps: sp(), rest });
      ctx.rotor(540, 390, 70, { arms, rps: sp(), rest });
      ctx.rotor(400, 560, 70, { arms, rps: sp(), rest });
      ctx.seg(WALL_L, 660, 336, 830);
      ctx.seg(WALL_R, 660, 464, 830);
    },
  },
  {
    id: 'crosswind',
    label: 'Crosswind',
    len: 900,
    build(ctx, rng) {
      const V = ctx.v;
      // An open drop through three bands of wind, alternating direction, each
      // gusting on and off on its own beat. Where you are blown depends on
      // WHEN you fall through, and a peg field below turns that into places.
      ctx.seg(WALL_L, 20, 300, 110);
      ctx.seg(WALL_R, 20, 500, 110);
      // Sanjay: "cross winds are not affecting marbles". Measured, they were
      // three thin bands blowing ALTERNATE ways, so a falling marble was
      // pushed right, then left, then right: of 583 sideways speed added, 278
      // survived, and 32% of marbles were pushed hard. Now ONE wind over the
      // whole drop that swings from one side to the other on a beat: nothing
      // cancels, and when you fall decides which way you are blown. A few
      // pins inside the wind turn a drift into a different line.
      const W = TUNE.crosswind || {};
      const force = W.force ?? V.force ?? 1300;
      ctx.zone('fan', WALL_L, 130, WALL_R, 540, { fx: (rng() < 0.5 ? 1 : -1) * force, fy: 0, swing: W.swing ?? V.swing ?? 1.1 });
      for (const [x, y] of [[260, 300], [540, 300], [400, 420]]) ctx.peg(x + rng.spread(12), y, 12);
      for (let row = 0; row < 2; row++) {
        const y = 580 + row * 70, n = row ? 3 : 4, span = row ? 150 : 140;
        const x0 = 400 - span * (n - 1) / 2 + rng.spread(10);
        for (let i = 0; i < n; i++) ctx.peg(x0 + i * span, y, 12);
      }
      ctx.seg(WALL_L, 700, 336, 860);
      ctx.seg(WALL_R, 700, 464, 860);
    },
  },
  {
    id: 'updraft',
    label: 'Updraft',
    len: 940,
    build(ctx, rng) {
      const V = ctx.v;
      // Vents blowing UP, stronger than gravity, in pulses. Catch a pulse and
      // you are held in the air while others fall past; miss it and you drop
      // straight through. Pure timing.
      ctx.seg(WALL_L, 20, 260, 120);
      ctx.seg(WALL_R, 20, 540, 120);
      const U = TUNE.updraft || {};
      ctx.zone('fan', 170, 180, 400, 520, { fx: 0, fy: -(U.force ?? V.force ?? 2300), cycle: { on: U.on ?? 0.7, off: U.off ?? 0.6 }, up: true });
      ctx.zone('fan', 400, 180, 630, 520, { fx: 0, fy: -(U.force ?? V.force ?? 2300), cycle: { on: U.on ?? 0.7, off: U.off ?? 0.6 }, up: true });
      ctx.peg(400, 600, 12); ctx.peg(260, 640, 12); ctx.peg(540, 640, 12);
      if (V.pegs) for (const [x, y] of [[285, 250], [515, 250], [400, 360], [285, 460], [515, 460]]) ctx.peg(x, y, 11);
      ctx.seg(WALL_L, 720, 336, 880);
      ctx.seg(WALL_R, 720, 464, 880);
    },
  },
  {
    id: 'coldstorage',
    label: 'Cold Storage',
    len: 900,
    build(ctx, rng) {
      const V = ctx.v;
      // Cryo traps in a peg field, each flashing on and off on its own beat.
      // Touch one while it is lit and you are frozen solid for two seconds,
      // an obstacle the others bounce off. Once per trap per marble.
      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      for (let row = 0; row < 4; row++) {
        const y = 150 + row * 110, n = row % 2 ? 3 : 4, span = row % 2 ? 150 : 140;
        const x0 = 400 - span * (n - 1) / 2 + rng.spread(8);
        for (let i = 0; i < n; i++) ctx.peg(x0 + i * span, y, 12);
      }
      const T = TUNE.coldstorage || {};
      const traps = [[190, 200], [400, 310], [610, 200], [300, 420], [500, 420]];
      for (let i = traps.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [traps[i], traps[j]] = [traps[j], traps[i]]; }
      for (const [x, y] of traps.slice(0, V.n ?? T.n ?? 3)) {
        ctx.zone('cryo', x - 34, y - 26, x + 34, y + 26, { cycle: { on: V.on ?? T.on ?? 0.45, off: V.off ?? T.off ?? 1.6 } });
      }
      ctx.seg(WALL_L, 640, 336, 820);
      ctx.seg(WALL_R, 640, 464, 820);
    },
  },
  {
    id: 'gaslimit',
    label: 'Gas Limit',
    len: 1000,
    build(ctx, rng) {
      // A fork: a steep express lane and a pegged local lane. The express
      // ends at a SPEED CAMERA that cuts anything over the limit to a crawl;
      // the local lane is too slow to trip it. Fast is not always fast.
      const flip = rng() < 0.5;
      const X = (x) => flip ? TRACK_W - x : x;
      const sg = (ax, ay, bx, by) => ctx.seg(X(ax), ay, X(bx), by);
      const T = TUNE.gaslimit || {};
      sg(WALL_L, 20, 340, 130);
      sg(WALL_R, 20, 460, 130);
      ctx.dome(400, 200, 20);
      sg(400, 218, 400, 700);                        // divider
      // Express: a long steep ramp on the left, ending at the camera.
      sg(385, 240, 120, 330);
      sg(WALL_L, 380, 330, 640);
      ctx.zone('brake', Math.min(X(230), X(370)), 560, Math.max(X(230), X(370)), 700,
               { vmax: T.vmax ?? 700, keep: T.keep ?? 0.35 });
      // Local: pegs.
      for (let row = 0; row < 4; row++) {
        const y = 290 + row * 95;
        const xs = row % 2 ? [520, 640] : [470, 580, 690 - 40];
        for (const x of xs) ctx.peg(X(x), y, 12);
      }
      sg(WALL_L, 740, 336, 920);
      sg(WALL_R, 740, 464, 920);
    },
  },
  {
    id: 'orderbook',
    label: 'Order Book',
    len: 960,
    build(ctx, rng) {
      // Floating conveyor slats, bids and asks, each running left or right
      // at its own speed and REVERSING on its own beat (Sanjay's idea,
      // measured: pairs swapped 1.2 in 10 with fixed belts, 1.9 reversing
      // every 1.0-1.8s; faster, 0.5-0.9s, swapped more but held marbles so
      // long the field strung out to 8.6s).
      ctx.seg(WALL_L, 20, 250, 100);
      ctx.seg(WALL_R, 20, 550, 100);
      // SERPENTINE (Sanjay: belts stacked without an offset caught nothing
      // below). Measured on the old stack, 200 races: only 27% of marbles
      // ever touched the first belt, 84% the second, 43% and 44% the rest,
      // 1.5 place swaps in 10, no spread added. Now belts are offset left and
      // right in turn and the outer end of each is walled off, so a marble
      // leaves over the one open end, which sits above the next belt: 58%,
      // 92%, 92% touched, 2.5 swaps, 5.9s through (+1.0s spread), 1 rescue
      // in 800 races. Four rows swapped no more (2.7) and took 7.4s.
      // A walled belt must not trap: a marble has to be able to ride its
      // whole length before the belt reverses, or it ping-pongs for ever
      // (330 long with the old 1.0-1.8s beat and 180+ speed: 3500 rescues
      // in 187 races). 220 long, belt 250-330, beat 1.3-1.7s: at least 325
      // units of travel a spell, 1.5x the length. The beat stops at 1.7s
      // because a marble waiting at the wall for the belt to turn counts as
      // stopped after 2.2s (1.9s: 2 rescues in 400 races; 1.5s: 0 but
      // 2.3 swaps).
      const mirror = rng() < 0.5, X = (x) => mirror ? TRACK_W - x : x;
      const beat = () => { const half = Math.round(240 * rng.range(1.3, 1.7)); return { half, phase: Math.floor(rng() * 2 * half) }; };
      for (let i = 0; i < 3; i++) {
        const y = 180 + i * 120, closedLeft = i % 2 === 0;
        const a = closedLeft ? 250 : 430, b = closedLeft ? 470 : 650;
        const sp = (rng() < 0.5 ? -1 : 1) * rng.range(250, 330);
        ctx.seg(X(a), y, X(b), y, { belt: sp, mu: 0.6, flip: beat() });
        const wx = closedLeft ? a : b;
        ctx.seg(X(wx), y - 40, X(wx), y);
      }
      ctx.seg(WALL_L, 680, 336, 900);
      ctx.seg(WALL_R, 680, 464, 900);
    },
  },
  {
    id: 'cannons',
    label: 'Cannons',
    len: 1000,
    build(ctx, rng) {
      // A dome splits the field onto two cannons. Each loads a marble, holds
      // it a moment, and fires it back across the course into the other
      // side's peg field. The two are set to different fuses, so which side
      // you went is time won or lost.
      ctx.seg(WALL_L, 20, 340, 130);
      ctx.seg(WALL_R, 20, 460, 130);
      ctx.dome(400, 200, 20);
      ctx.seg(WALL_L, 250, 150, 360);
      ctx.seg(WALL_R, 250, 650, 360);
      ctx.seg(385, 220, 180, 330);
      ctx.seg(415, 220, 620, 330);
      const d = rng() < 0.5 ? [0.35, 0.9] : [0.9, 0.35];
      ctx.cannon(150, 350, 160, 330, 520, -520, { delay: d[0] });
      ctx.cannon(650, 350, 640, 330, -520, -520, { delay: d[1] });
      for (let row = 0; row < 3; row++) {
        const y = 520 + row * 85, n = row % 2 ? 4 : 5, span = row % 2 ? 130 : 125;
        const x0 = 400 - span * (n - 1) / 2;
        for (let i = 0; i < n; i++) ctx.peg(x0 + i * span, y, 12);
      }
      ctx.seg(WALL_L, 780, 336, 940);
      ctx.seg(WALL_R, 780, 464, 940);
    },
  },
  {
    id: 'marketmakers',
    label: 'Market Makers',
    len: 900,
    build(ctx, rng) {
      const V = ctx.v;
      // Rows of bumpers gliding side to side at different speeds. The gap you
      // fall through is wherever they are not.
      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      const rows = V.rows ?? 4, dy = 480 / rows;
      for (let row = 0; row < rows; row++) {
        const y = 170 + row * dy;
        const secs = rng.range(V.lo ?? 1.6, V.hi ?? 3.2);
        const n = row % 2 ? 2 : 3;
        for (let i = 0; i < n; i++) {
          const c = 400 + (i - (n - 1) / 2) * 200;
          ctx.mover(c - 70, y, c + 70, y, { r: V.r ?? 18, secs });
        }
      }
      ctx.seg(WALL_L, 660, 336, 840);
      ctx.seg(WALL_R, 660, 464, 840);
    },
  },
  {
    id: 'pachinko',
    label: 'Pachinko',
    len: 1100,
    build(ctx, rng) {
      const V = ctx.v;
      // A tall, dense pin board with a few pins missing, seeded. The classic
      // shuffler, just bigger.
      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      for (let row = 0; row < (V.rows ?? 10); row++) {
        const y = 140 + row * 72;
        const span = V.span ?? 96, n = Math.floor(470 / span) + (row % 2 ? 0 : 1);
        const x0 = 400 - span * (n - 1) / 2;
        for (let i = 0; i < n; i++) if (rng() > (V.miss ?? 0.12)) ctx.peg(x0 + i * span + rng.spread(5), y, V.r ?? 9);
      }
      const end = 140 + (V.rows ?? 10) * 72 + 40;
      ctx.seg(WALL_L, end, 336, end + 160);
      ctx.seg(WALL_R, end, 464, end + 160);
    },
  },
  {
    id: 'popbumpers',
    label: 'Pop Bumpers',
    len: 880,
    build(ctx, rng) {
      // Pinball pop bumpers: they hit back harder than they are hit
      // (restitution above 1), so a marble that finds a cluster is flung.
      ctx.seg(WALL_L, 20, 260, 110);
      ctx.seg(WALL_R, 20, 540, 110);
      const c = 400 + rng.spread(40);
      for (const [dx, dy] of [[0, 220], [-120, 330], [120, 330], [-60, 460], [60, 460]]) {
        ctx.peg(c + dx, dy, 24, { rest: 1.1, mu: 0.02 });
      }
      ctx.peg(180, 560, 12); ctx.peg(620, 560, 12);
      ctx.seg(WALL_L, 640, 336, 820);
      ctx.seg(WALL_R, 640, 464, 820);
    },
  },
  {
    id: 'looprow',
    label: 'Loop Row',
    len: 1860,
    build(ctx, rng) {
      const V = ctx.v;
      // Sanjay's idea: a whole section of loops. Two loop forks, one under
      // the other and mirrored: at each a marble either rides the loop or
      // takes the short way, so every marble gets two separate coin tosses.
      const first = rng() < 0.5;
      for (let i = 0; i < (V.forks ?? 2); i++) loopFork(ctx, rng, i * 920, i % 2 ? !first : first);
    },
  },
  {
    id: 'rugpull',
    label: 'Rug Pull',
    len: 900,
    build(ctx, rng) {
      // A slide with a TRAPDOOR in it that drops open on a beat. Cross it
      // while it is shut and you ride the slide; hit it open and you are
      // dropped onto the slow road underneath, which runs back the other way.
      const flip = rng() < 0.5;
      const X = (x) => flip ? TRACK_W - x : x;
      const sg = (ax, ay, bx, by, o) => ctx.seg(X(ax), ay, X(bx), by, o);
      const period = Math.round(240 * rng.range(1.0, 1.4));
      const gate = { period, open: 70, phase: Math.floor(rng() * period), label: 'RUG PULL' };
      sg(WALL_R, 20, 230, 170);                       // everyone to the left first
      sg(WALL_L, 230, 250, 290);                      // the slide
      sg(250, 290, 460, 350, { gate, tray: true });   // the trapdoor
      sg(460, 350, 640, 400);
      // The slow road: back to the left, gently.
      sg(610, 450, 150, 560);
      if (ctx.v.bull) {
        // The Bull Trap: the trapdoor is signposted as a SHORTCUT, and the
        // road under it is longer still. A lie, painted on the course.
        ctx.sign(X(350), 250, 'SHORTCUT ▼', 'bull');
        sg(WALL_L, 585, 500, 690);
      }
      sg(WALL_L, 680, 336, 840);
      sg(WALL_R, 680, 464, 840);
    },
  },
  {
    id: 'halving',
    label: 'The Halving',
    len: 1000,
    build(ctx, rng) {
      // The road splits in two. One half is short and cluttered with pins,
      // the other long and clean. Roughly even on average, never on the day.
      const flip = rng() < 0.5;
      const X = (x) => flip ? TRACK_W - x : x;
      const sg = (ax, ay, bx, by) => ctx.seg(X(ax), ay, X(bx), by);
      sg(WALL_L, 20, 340, 130);
      sg(WALL_R, 20, 460, 130);
      ctx.dome(400, 195, 20);
      sg(400, 213, 400, 760);
      // Short, cluttered.
      for (const [x, y] of [[200, 300], [320, 360], [150, 420], [270, 480], [190, 560], [320, 620]]) ctx.peg(X(x), y, 12);
      // Long, clean: switchbacks.
      sg(415, 240, 650, 330);
      sg(WALL_R, 390, 520, 470);
      sg(415, 540, 650, 620);
      sg(WALL_L, 800, 336, 950);
      sg(WALL_R, 780, 464, 950);
    },
  },
  {
    id: 'whale',
    label: 'The Whale',
    len: 820,
    build(ctx, rng) {
      const V = ctx.v;
      // One enormous bumper cruising back and forth across the drop. It
      // decides who goes left and who goes right, and hits hard.
      ctx.seg(WALL_L, 20, 280, 120);
      ctx.seg(WALL_R, 20, 520, 120);
      for (const y of V.ys ?? [330]) ctx.mover(250, y, 550, y, { r: V.r ?? 56, secs: rng.range(2.2, 3.2), rest: 0.9 });
      const e = V.end ?? 600;
      ctx.peg(180, e - 100, 12); ctx.peg(400, e - 80, 12); ctx.peg(620, e - 100, 12);
      ctx.seg(WALL_L, e, 336, e + 180);
      ctx.seg(WALL_R, e, 464, e + 180);
    },
  },
  {
    id: 'pistons',
    label: 'Pistons',
    len: 860,
    build(ctx, rng) {
      const V = ctx.v;
      // Bumpers pumping up and down on their own beats, in a staggered
      // field. A rising piston throws a marble back up; a falling one lets it
      // through.
      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      for (const [x, y] of V.at ?? [[230, 220], [400, 300], [570, 220], [300, 470], [500, 470]]) {
        ctx.mover(x, y - 55, x, y + 55, { r: 18, secs: rng.range(1.2, 2.0), rest: 0.8 });
      }
      const e = V.end ?? 640;
      ctx.seg(WALL_L, e, 336, e + 180);
      ctx.seg(WALL_R, e, 464, e + 180);
    },
  },
  {
    id: 'slingshots',
    label: 'Slingshots',
    len: 900,
    build(ctx, rng) {
      const V = ctx.v;
      // Pinball slingshots: angled kicker walls that throw back harder than
      // they are hit, down both sides, over a pin field.
      ctx.seg(WALL_L, 20, 280, 110);
      ctx.seg(WALL_R, 20, 520, 110);
      const rows = V.rows ?? 2, dy = 440 / rows;
      for (let i = 0; i < rows; i++) {
        const y = 200 + i * dy;
        ctx.seg(150, y, 260, y + dy * 0.6, { rest: 0.98, kicker: true });
        ctx.seg(650, y, 540, y + dy * 0.6, { rest: 0.98, kicker: true });
        ctx.peg(400 + rng.spread(30), y + 60, 14);
      }
      ctx.seg(WALL_L, 700, 336, 860);
      ctx.seg(WALL_R, 700, 464, 860);
    },
  },
  {
    id: 'zigzag',
    label: 'Zigzag',
    len: 1000,
    build(ctx, rng) {
      const V = ctx.v;
      // Four switchbacks with a bumper at every turn. The bumper sends some
      // straight on, some back.
      let left = rng() < 0.5;
      const n = V.n ?? 3, dy = 750 / n;
      for (let i = 0; i < n; i++) {
        const y = 60 + i * dy;
        if (left) {
          ctx.seg(WALL_L, y, 620, y + dy * 0.64);
          ctx.peg(652, y + dy * 0.85, 12);
        } else {
          ctx.seg(WALL_R, y, 180, y + dy * 0.64);
          ctx.peg(148, y + dy * 0.85, 12);
        }
        left = !left;
      }
      ctx.seg(WALL_L, 860, 336, 970);
      ctx.seg(WALL_R, 860, 464, 970);
    },
  },
  {
    id: 'blizzard',
    label: 'Blizzard',
    len: 960,
    build(ctx, rng) {
      const V = ctx.v;
      // Gusting crosswinds and two cryo traps in one drop. Get blown into a
      // trap while it is lit and you are frozen where you hang.
      ctx.seg(WALL_L, 20, 280, 110);
      ctx.seg(WALL_R, 20, 520, 110);
      // Each gust swings side to side on its own beat (fixed alternating
      // bands cancelled each other out: 11% of marbles pushed hard).
      for (let i = 0; i < 2; i++) {
        ctx.zone('fan', WALL_L, 140 + i * 200, WALL_R, 270 + i * 200, { fx: (rng() < 0.5 ? 1 : -1) * (V.force ?? 1800), fy: 0, swing: rng.range(0.7, 1.2) });
      }
      const side = rng() < 0.5 ? -1 : 1;
      ctx.zone('cryo', 400 + side * 150 - 36, 290, 400 + side * 150 + 36, 344, { cycle: { on: 0.5, off: 1.4 } });
      ctx.zone('cryo', 400 - side * 150 - 36, 500, 400 - side * 150 + 36, 554, { cycle: { on: 0.5, off: 1.4 } });
      if (V.whiteout) ctx.zone('cryo', 364, 180, 436, 234, { cycle: { on: 0.5, off: 1.4 } });
      ctx.peg(400, 420, 12); ctx.peg(260, 620, 12); ctx.peg(540, 620, 12);
      ctx.seg(WALL_L, 720, 336, 900);
      ctx.seg(WALL_R, 720, 464, 900);
    },
  },
  {
    id: 'jetstream',
    label: 'Jetstream',
    len: 900,
    build(ctx, rng) {
      // Two long slides, each with a jet blowing along it in pulses: with you
      // on the first, against you on the second. When you arrive decides
      // whether you are carried or held.
      const flip = rng() < 0.5;
      const X = (x) => flip ? TRACK_W - x : x;
      const sg = (ax, ay, bx, by) => ctx.seg(X(ax), ay, X(bx), by);
      const zx = (a, b) => [Math.min(X(a), X(b)), Math.max(X(a), X(b))];
      sg(WALL_R, 20, 300, 140);
      sg(WALL_L, 180, 640, 340);
      let [a, b] = zx(WALL_L, 640);
      ctx.zone('fan', a, 120, b, 330, { fx: (flip ? -1 : 1) * 1500, fy: 0, cycle: { on: 0.8, off: 0.8 } });
      sg(WALL_R, 430, 160, 590);
      [a, b] = zx(160, WALL_R);
      // Against you: weaker than the slope's own pull, or a marble is held
      // at the top for good (it was: every race).
      ctx.zone('fan', a, 380, b, 580, { fx: (flip ? -1 : 1) * 330, fy: 0, cycle: { on: 0.9, off: 0.7 } });
      sg(WALL_L, 680, 336, 850);
      sg(WALL_R, 680, 464, 850);
    },
  },
  {
    id: 'miningwheel',
    label: 'Mining Wheel',
    len: 900,
    build(ctx, rng) {
      const V = ctx.v;
      // A big, slow six-spoke wheel. Land on a spoke and you are carried
      // round until it tips you off; land between and you drop straight on.
      ctx.seg(WALL_L, 20, 300, 140);
      ctx.seg(WALL_R, 20, 500, 140);
      if (V.twin) {
        const d = rng() < 0.5 ? -1 : 1;
        ctx.rotor(265, 380, 105, { arms: 5, rps: d * 0.22, fr: 6 });
        ctx.rotor(535, 380, 105, { arms: 5, rps: -d * 0.22, fr: 6 });
      } else ctx.rotor(400, 390, 150, { arms: 6, rps: (rng() < 0.5 ? -1 : 1) * 0.16, fr: 6 });
      ctx.seg(WALL_L, 640, 336, 840);
      ctx.seg(WALL_R, 640, 464, 840);
    },
  },
  {
    id: 'airdrop',
    label: 'Airdrop',
    len: 860,
    build(ctx, rng) {
      const V = ctx.v;
      // A tray of six cups, like the Mempool's, but every cup has its OWN
      // floor, and they open one at a time in a seeded order, round and round.
      // Which cup you fell into is a ticket in a draw: the cup that opens
      // next goes first, whoever got there first.
      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      for (let i = 0; i < 3; i++) ctx.peg(260 + i * 140 + rng.spread(10), 170, 12);
      const period = Math.round(240 * rng.range(1.2, 1.5));
      const order = [...Array(V.cups ?? 6).keys()];
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const cups = V.cups ?? 6, trayY = 300, cup = 600 / cups, depth = 20, x0 = 100;
      ctx.seg(WALL_L, trayY - 40, x0, trayY);
      ctx.seg(WALL_R, trayY - 40, x0 + cups * cup, trayY);
      const base = Math.floor(rng() * period);
      for (let i = 0; i < cups; i++) {
        const a = x0 + i * cup;
        const gate = { period, open: 48, phase: (base + Math.round(order[i] * period / cups)) % period, label: 'AIRDROP', cup: i, wear: true };
        ctx.seg(a, trayY, a + cup / 2, trayY + depth, { gate, tray: true });
        ctx.seg(a + cup / 2, trayY + depth, a + cup, trayY, { gate, tray: true });
        ctx.hold(a, trayY - 60, a + cup, trayY + depth + 16, gate);
      }
      for (let row = 0; row < 2; row++) {
        const y = 440 + row * 90, n = row ? 4 : 5, span = row ? 130 : 125;
        const px = 400 - span * (n - 1) / 2;
        for (let i = 0; i < n; i++) ctx.peg(px + i * span, y, 12);
      }
      ctx.seg(WALL_L, 640, 336, 820);
      ctx.seg(WALL_R, 640, 464, 820);
    },
  },
  {
    id: 'candles',
    label: 'Candlesticks',
    len: 900,
    build(ctx, rng) {
      const V = ctx.v;
      // A forest of candlesticks: upright bars of seeded heights, the pins
      // of a price chart, staggered so the field weaves between them.
      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      const rows = V.rows ?? 3, dy = 510 / rows;
      for (let row = 0; row < rows; row++) {
        const y = 200 + row * dy, n = row % 2 ? 3 : 4, span = row % 2 ? 150 : 140;
        const x0 = 400 - span * (n - 1) / 2;
        for (let i = 0; i < n; i++) {
          // Candles in neighbouring rows must leave a marble's width and
          // more between their ends, or two of them make a pocket (the Candle
          // Storm's tighter rows held a marble for good, 1 race in 400).
          const len = rng.range(40, Math.min(110, dy - 60));
          ctx.island(x0 + i * span + rng.spread(12), y, 10, len, Math.PI / 2, { candle: rng() < 0.5 ? 'up' : 'down' });
        }
      }
      ctx.seg(WALL_L, 700, 336, 860);
      ctx.seg(WALL_R, 700, 464, 860);
    },
  },
  {
    id: 'firewall',
    label: 'Firewall',
    len: 900,
    build(ctx, rng) {
      const V = ctx.v;
      // Laser barriers across half the course, left then right, each
      // switching on and off on its own beat. A lit laser is a floor: land on
      // it and you wait for it to drop (never more than a second).
      ctx.seg(WALL_L, 20, 250, 100);
      ctx.seg(WALL_R, 20, 550, 100);
      let side = rng() < 0.5 ? -1 : 1;
      const n = V.n ?? 3, dy = 450 / n;
      for (let i = 0; i < n; i++) {
        const y = 200 + i * dy;
        const period = Math.round(240 * rng.range(1.2, 1.6));
        const gate = { period, open: Math.round(period * 0.45), phase: Math.floor(rng() * period), wear: true };
        const a = side < 0 ? WALL_L : 400, b = side < 0 ? 400 : WALL_R;
        ctx.seg(a, y, b, y, { gate, laser: 'red' });
        ctx.hold(a, y - 40, b, y + 4, gate);
        if (dy >= 120) ctx.peg(side < 0 ? 560 : 240, y + 40, 12);
        side = -side;
      }
      ctx.seg(WALL_L, 700, 336, 860);
      ctx.seg(WALL_R, 700, 464, 860);
    },
  },
  {
    id: 'escalator',
    label: 'Escalator',
    len: 960,
    build(ctx, rng) {
      const V = ctx.v;
      // Stairs of conveyor belts, FLOATING clear of the wall at their top
      // end. Each belt runs with the slope (flings you on) or against it
      // (carries you back up and off its top end, down the side: a different
      // road). The first build ran the steps into the wall, and a belt
      // running uphill pinned a marble in that corner (so did running them
      // out to 20 from the wall again, 1041 rescues in 300 races: do not).
      // Sanjay: marbles rode the first belt and skipped the rest. Measured,
      // 300 races, share of marbles that ever touched belt 1/2/3/4: 98/0/1/15%.
      // A marble leaves a belt's low end at belt speed and lands about 120
      // further on, but belts were 470 long and the next one's high end stood
      // only 30 past that end: every marble overshot it. Now 320 long and a
      // steeper step (0.75 of the spacing, was 0.58), so the exit lands inside
      // the next belt: 51/90/79/79% touched, place swaps 0.9 -> 2.1, 0 rescues,
      // 5.4s through (was 2.7), field spread +2.2s (was +0.7).
      let left = rng() < 0.5;
      const n = V.n ?? 4, dy = 760 / n;
      for (let i = 0; i < n; i++) {
        const y = 60 + i * dy;
        const up = rng() < 0.45;
        // Grip on an uphill belt stays below the slope's own pull (0.15 against
        // ~0.23): at 0.25 the two balanced and a marble hung still mid-belt.
        const sp = up ? -rng.range(150, 240) : rng.range(250, 450), mu = up ? (TUNE.escalator?.upMu ?? 0.15) : 0.5;
        if (left) ctx.seg(150, y, 470, y + dy * 0.75, { belt: sp, mu });
        else ctx.seg(650, y, 330, y + dy * 0.75, { belt: sp, mu });
        left = !left;
      }
      ctx.seg(WALL_L, 840, 336, 940);
      ctx.seg(WALL_R, 840, 464, 940);
    },
  },
  {
    id: 'cascade',
    label: 'Liquidity Cascade',
    len: 960,
    build(ctx, rng) {
      const V = ctx.v;
      // Three tiers of cups, every cup with its own trapdoor on its own beat
      // (1.0-1.5s, Sanjay's cap on any wait). A marble waits in whichever cup
      // it fell in for whenever THAT cup next opens, three times over. The
      // strongest shuffler measured in the library is the one that holds
      // marbles for different lengths of time, and this is that, cubed.
      const tiers = V.tiers ?? 3, cups = V.cups ?? 4, dy = 750 / tiers;
      // Which way the quarter-cup offset goes, per course: always right, it
      // left the right-hand start slot leading out of it 16% of races.
      const side = TUNE.openLips === false ? 1 : rng() < 0.5 ? -1 : 1;
      // Entry lips of a random reach per side (110-300), as on the Draw, so
      // the wall slots are not always the ones rolled into the outer cups.
      if (TUNE.openLips !== false) {
        ctx.seg(WALL_L, 0, rng.range(110, 300), 40);
        ctx.seg(WALL_R, 0, TRACK_W - rng.range(110, 300), 40);
      }
      for (let tier = 0; tier < tiers; tier++) {
        // An even number of cups puts a rim, a knife edge, on the centre line
        // everything drops down: shift the row a quarter cup off it.
        const cup = 520 / cups, y = 170 + tier * dy, x0 = 140 + (cups % 2 ? 0 : side * cup / 4), depth = 22;
        ctx.seg(WALL_L, y - 60, x0, y);
        ctx.seg(WALL_R, y - 60, x0 + cups * cup, y);
        for (let i = 0; i < cups; i++) {
          const period = Math.round(240 * rng.range(1.0, 1.5));
          const gate = { period, open: 50, phase: Math.floor(rng() * period), label: 'TIER ' + (tier + 1), wear: true };
          const a = x0 + i * cup;
          ctx.seg(a, y, a + cup / 2, y + depth, { gate, tray: true, quiet: true });
          ctx.seg(a + cup / 2, y + depth, a + cup, y, { gate, tray: true, quiet: true });
          ctx.hold(a, y - 70, a + cup, y + depth + 16, gate);
        }
      }
      ctx.seg(WALL_L, 780, 336, 920);
      ctx.seg(WALL_R, 780, 464, 920);
    },
  },
  {
    id: 'turnstiles',
    label: 'Turnstiles',
    len: 1000,
    build(ctx, rng) {
      const V = ctx.v;
      // Two funnels, each closed off at the bottom by a four-arm turnstile
      // that lets one pocket through at a time. The field queues, and who
      // is in the pocket when it comes round goes next.
      const T = TUNE.turnstiles || {};
      const n = V.n ?? 2, dy = 840 / n;
      for (let k = 0; k < n; k++) {
        const cy = 60 + dy * 0.45 + k * dy, R = V.R ?? T.R ?? 70, lip = R + (V.clear ?? T.clear ?? 36);   // 16 jammed a marble between arm tip and lip
        const cx = 400 + (k ? 1 : -1) * rng.range(0, 60);
        ctx.seg(WALL_L, cy - dy * 0.42, cx - lip, cy);
        ctx.seg(WALL_R, cy - dy * 0.42, cx + lip, cy);
        ctx.rotor(cx, cy, R, { arms: V.arms ?? T.arms ?? 4, rps: (k % 2 ? -1 : 1) * (V.rps ?? T.rps ?? 0.4), fr: 6, rest: 0.2 });
      }
      ctx.seg(WALL_L, 830, 336, 960);
      ctx.seg(WALL_R, 830, 464, 960);
    },
  },
  {
    id: 'pinball',
    label: 'Pinball',
    len: 1200,
    build(ctx, rng) {
      const V = ctx.v;
      // The arcade: pop bumpers at the top, then a flipper on each side, fed
      // by ramps. Built as a FINALE: everything in it throws marbles about.
      ctx.seg(WALL_L, 20, 250, 110);
      ctx.seg(WALL_R, 20, 550, 110);
      const c = 400 + rng.spread(30);
      for (const [dx, dy] of V.pops ?? [[0, 190], [-110, 290], [110, 290]]) ctx.peg(c + dx, dy, 24, { rest: 1.1, mu: 0.02 });
      let side = rng() < 0.5 ? -1 : 1;
      for (let i = 0; i < (V.flippers ?? 2); i++) {
        const y0 = 400 + i * 360;
        if (side < 0) ctx.seg(WALL_R, y0, 430 - 30 * side, y0 + 95);
        else ctx.seg(WALL_L, y0, 370 - 30 * side, y0 + 95);
        ctx.flipper(side, y0 + 215, { len: 170 });
        side = -side;
      }
    },
  },
  {
    id: 'bouncehouse',
    label: 'Bounce House',
    len: 1180,
    build(ctx, rng) {
      const V = ctx.v;
      // Trampolines and pop bumpers together: a pad throws you up into a
      // bumper, the bumper throws you anywhere.
      ctx.seg(WALL_L, 30, 300, 110);
      ctx.seg(WALL_R, 30, 500, 110);
      for (let r = 0; r < (V.rows ?? 4); r++) {
        const y = 230 + r * 220, n = r % 2 ? 2 : 3, half = 40;
        for (const x of ctx.place(Array(n).fill(half))) {
          const tilt = (rng() < 0.5 ? -1 : 1) * rng.range(0.14, 0.3);
          const dx = dcos(tilt) * half, dy = dsin(tilt) * half;
          ctx.spring(x - dx, y - dy, x + dx, y + dy, { base: 380, gain: 0.5 });
        }
        ctx.peg(r % 2 ? 400 + rng.spread(40) : (rng() < 0.5 ? 260 : 540), y - 110, 20, { rest: 1.1, mu: 0.02 });
      }
    },
  },
  {
    id: 'threechains',
    label: 'Three Chains',
    len: 1000,
    build(ctx, rng) {
      // Three lanes, three different machines: a pin lane, a conveyor lane
      // and a wind lane. Which lane you drop into is chance, and no lane is
      // reliably the fastest.
      ctx.seg(WALL_L, 20, 250, 90);
      ctx.seg(WALL_R, 20, 550, 90);
      for (const x of [300, 400, 500]) ctx.peg(x + rng.spread(12), 150, 12);
      ctx.seg(280, 230, 280, 720);
      ctx.seg(520, 230, 520, 720);
      const order = [0, 1, 2];
      for (let i = 2; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const lanes = [[WALL_L, 280], [280, 520], [520, WALL_R]];
      order.forEach((kind, li) => {
        const [a, b] = lanes[li], mid = (a + b) / 2, w = b - a;
        if (kind === 0) {
          for (let r = 0; r < 4; r++) {
            const px = mid + (r % 2 ? -1 : 1) * Math.min(38, w / 2 - 70);
            if (px - 12 >= a + MIN_GAP && px + 12 <= b - MIN_GAP) ctx.peg(px, 300 + r * 100, 12);
          }
        } else if (kind === 1) {
          ctx.seg(a, 330, b - 60, 400, { belt: rng() < 0.5 ? 300 : -160, mu: 0.3 });
          ctx.seg(b, 520, a + 60, 590, { belt: rng() < 0.5 ? 300 : -160, mu: 0.3 });
        } else {
          ctx.zone('fan', a, 280, b, 660, { fx: 0, fy: -2100, cycle: { on: 0.45, off: 0.9 }, up: true });
        }
      });
      ctx.seg(WALL_L, 780, 336, 940);
      ctx.seg(WALL_R, 780, 464, 940);
    },
  },
  {
    id: 'geysers',
    label: 'Geysers',
    len: 920,
    build(ctx, rng) {
      const V = ctx.v;
      // Narrow vents in a pin field that blast upward in short bursts, each
      // on its own beat. Caught by one and you are thrown back up the board.
      ctx.seg(WALL_L, 20, 240, 100);
      ctx.seg(WALL_R, 20, 560, 100);
      const vents = V.vents ?? [265, 535, 400];
      const G = TUNE.geysers || {};
      // Air, measured (Sanjay: "the air is not doing enough"): 70-wide vents
      // blowing 0.35s in 1.45 pushed only 9-18% of marbles hard. Wider, longer
      // and stronger: 37%. Pushing EVERYONE is not the goal, though: a wider
      // vent that cleared the pegs pushed 70% and shuffled half as much. What
      // reorders a field is air that catches some marbles and not others, over
      // pegs that turn that into different lines.
      const half = G.half ?? V.half ?? 55;
      for (let row = 0; row < 4; row++) {
        const y = 160 + row * 110, n = row % 2 ? 3 : 4, span = row % 2 ? 150 : 140;
        const x0 = 400 - span * (n - 1) / 2;
        for (let i = 0; i < n; i++) {
          const x = x0 + i * span;
          // No peg inside a vent's column: see below.
          if (vents.every(v => Math.abs(v - x) > (V.clear ?? Math.max(50, half - 10)))) ctx.peg(x, y, 11);
        }
      }
      // Vents sit BETWEEN peg columns and lean a little sideways. A vent
      // straight over a peg held a marble balanced on the peg's crown,
      // bounced straight up and straight back down for ever: three marbles
      // in one race of 300.
      for (const x of vents) {
        const lean = x < 400 ? 260 : -260;
        ctx.zone('fan', x - half, 220, x + half, 560, { fx: lean, fy: -(G.force ?? V.force ?? 3400),
          cycle: { on: G.on ?? 0.45, off: G.off ?? V.off ?? 0.75 }, up: true });
      }
      ctx.seg(WALL_L, 660, 336, 860);
      ctx.seg(WALL_R, 660, 464, 860);
    },
  },
  {
    id: 'plinko',
    label: 'Plinko Jackpot',
    len: 1100,
    build(ctx, rng) {
      const V = ctx.v;
      // A plinko board that ends in five cups, each with its own trapdoor on
      // its own beat: bounce down, land in a cup, wait for it to pay out.
      // Entry lips of a random reach per side (110-300), as on the Draw: a
      // fixed 230 always caught the two corner marbles, who led out of the
      // board 15-16% each against 23-25% for the two beside them.
      const LP = TUNE.openLips;
      const lipL = LP === false ? 230 : rng.range(110, 300), lipR = LP === false ? 230 : rng.range(110, 300);
      ctx.seg(WALL_L, 20, lipL, 90);
      ctx.seg(WALL_R, 20, TRACK_W - lipR, 90);
      for (let row = 0; row < (V.rows ?? 6); row++) {
        const y = 140 + row * 70, n = row % 2 ? 5 : 6, span = 96;
        const x0 = 400 - span * (n - 1) / 2;
        // Seeded jitter: a pin dead under the centre line held a marble dropped
        // exactly there, balanced on its crown (4 in 41 races).
        for (let i = 0; i < n; i++) if (rng() > 0.1) ctx.peg(x0 + i * span + rng.spread(5), y, 9);
      }
      // Even cup counts: a quarter cup off centre, as in the Cascade.
      const cups = V.cups ?? 5, cup = 600 / cups, y = 200 + (V.rows ?? 6) * 70, x0 = 100 - (cups % 2 ? 0 : cup / 4), depth = 22;
      ctx.seg(WALL_L, y - 50, x0, y);
      ctx.seg(WALL_R, y - 50, x0 + cups * cup, y);
      for (let i = 0; i < cups; i++) {
        const period = Math.round(240 * rng.range(1.0, 1.5));
        const gate = { period, open: 50, phase: Math.floor(rng() * period), label: 'JACKPOT', wear: true };
        const a = x0 + i * cup;
        ctx.seg(a, y, a + cup / 2, y + depth, { gate, tray: true, quiet: true });
        ctx.seg(a + cup / 2, y + depth, a + cup, y, { gate, tray: true, quiet: true });
        ctx.hold(a, y - 70, a + cup, y + depth + 16, gate);
      }
      ctx.seg(WALL_L, y + 280, 336, y + 440);
      ctx.seg(WALL_R, y + 280, 464, y + 440);
    },
  },
  {
    id: 'wreckingballs',
    label: 'Wrecking Balls',
    len: 940,
    build(ctx, rng) {
      const V = ctx.v;
      // Three heavy balls swinging across the drop at different heights and
      // speeds. Get clipped and you go wherever you are sent.
      ctx.seg(WALL_L, 20, 260, 110);
      ctx.seg(WALL_R, 20, 540, 110);
      const n = V.n ?? 3, dy = 510 / n;
      for (let i = 0; i < n; i++) {
        const y = 210 + i * dy;
        ctx.mover(210, y, 590, y, { r: V.r ?? 38, secs: rng.range(1.8, 3.0), rest: 0.9 });
      }
      ctx.seg(WALL_L, 720, 336, 890);
      ctx.seg(WALL_R, 720, 464, 890);
    },
  },
  {
    id: 'hopper',
    label: 'The Hopper',
    len: 900,
    build(ctx, rng) {
      // A deep hopper with one outlet, and a plug that slides back and forth
      // across it. The field piles up behind the plug; each time it slides
      // clear, whoever is sitting over the outlet drops.
      const cx = 400 + rng.spread(30);
      ctx.seg(WALL_L, 40, cx - 60, 420);
      ctx.seg(WALL_R, 40, cx + 60, 420);
      // The plug runs UNDER the outlet (its top 4 below the funnel's lips).
      // At 432 it reached up past the lips, swept marbles rolling down the
      // funnel back up it, and met them again on the same beat: a loop.
      ctx.mover(cx - 110, 458, cx + 110, 458, { r: 34, secs: rng.range(1.0, 1.4), rest: 0.3 });
      ctx.peg(260, 580, 12); ctx.peg(540, 580, 12); ctx.peg(cx, 650, 12);
      ctx.seg(WALL_L, 700, 336, 860);
      ctx.seg(WALL_R, 700, 464, 860);
    },
  },
  {
    id: 'lasergrid',
    label: 'Laser Grid',
    len: 890,
    build(ctx, rng) {
      // After Antigravity's laser field, which Sanjay liked: full-width
      // lasers stacked up the drop, each switching on and off on its own
      // beat, and BOUNCY while lit. A marble that falls between two lit
      // lasers pings between them until the one below it switches off, a hold
      // of random length (never a whole second) at every level: the kind of
      // hold-and-release the shuffle bench says works best.
      const V = ctx.v;
      ctx.seg(WALL_L, 20, 250, 100);
      ctx.seg(WALL_R, 20, 550, 100);
      const n = V.n ?? 4, gap = V.gap ?? 120;
      for (let i = 0; i < n; i++) {
        const y = 170 + i * gap;
        const period = Math.round(240 * rng.range(0.9, 1.3));
        const gate = { period, open: Math.round(period * rng.range(0.45, 0.6)), phase: Math.floor(rng() * period), wear: true };
        ctx.seg(WALL_L, y, WALL_R, y, { gate, laser: 'green', rest: V.rest ?? 0.75 });
        // Resting on a lit laser is waiting for it, not being stuck: with
        // worn closed spells up to 2.5s, such marbles were "rescued".
        ctx.hold(WALL_L, y - 40, WALL_R, y + 4, gate);
      }
      const e = 170 + n * gap + 20;
      ctx.peg(260, e, 12); ctx.peg(540, e, 12);
      ctx.seg(WALL_L, e + 60, 336, e + 200);
      ctx.seg(WALL_R, e + 60, 464, e + 200);
    },
  },
  // ------------------------------------------------------------------
  // CRYPTO MACHINES (2026-09-25), Sanjay's pick from the ideas list. Every
  // one is a hold, a detour or a launch whose size depends on WHEN a marble
  // arrives, which the shuffle bench says is what reorders a field.
  // ------------------------------------------------------------------
  {
    id: 'bridge',
    label: 'Cross-Chain Bridge',
    len: 900,
    build(ctx, rng) {
      // Two bridge portals, one each side. A marble that reaches one is
      // held for a CONFIRMATION of 0.4-1.4s (set by the moment it arrived)
      // and comes out on the other chain, the far side of the course.
      ctx.seg(WALL_L, 20, 340, 130);
      ctx.seg(WALL_R, 20, 460, 130);
      ctx.dome(400, 195, 20);
      ctx.seg(385, 215, 170, 300);
      ctx.seg(415, 215, 630, 300);
      for (const side of [-1, 1]) {
        const cx = 400 + side * 260;
        ctx.seg(cx - 60, 330, cx, 372);
        ctx.seg(cx, 372, cx + 60, 330);
        ctx.cannon(cx, 352, 400 - side * 220, 560, side * 180, 120,
                   { teleport: true, kind: 'bridge', delay: 0.4, delayHi: 1.4, gap: 50 });
      }
      for (const [x, y] of [[260, 640], [400, 610], [540, 640]]) ctx.peg(x + rng.spread(6), y, 12);
      ctx.seg(WALL_L, 720, 336, 870);
      ctx.seg(WALL_R, 720, 464, 870);
    },
  },
  {
    id: 'reorg',
    label: 'Chain Reorg',
    len: 940,
    build(ctx, rng) {
      // Two switchbacks, each with a REORG zone flickering on it. Roll
      // through one while it is lit and your last block is undone: back to
      // the top of that ramp, about a second lost. (Sending marbles back to
      // the top of the section made it the slowest thing in the library.)
      ctx.seg(WALL_L, 20, 250, 100);
      ctx.seg(WALL_R, 20, 550, 100);
      const T = TUNE.reorg || {};
      const flip = rng() < 0.5;
      const X = (x) => flip ? TRACK_W - x : x;
      const box = (a, b, y0, y1) => [Math.min(X(a), X(b)), y0, Math.max(X(a), X(b)), y1];
      ctx.seg(X(WALL_L), 230, X(600), 380);
      ctx.seg(X(WALL_R), 470, X(200), 620);
      // Sent back a measured 1.0-1.5s (Sanjay's cap), not to the top of the ramp:
      // from the ramp's start the worst case was 2.2s.
      const zones = [[box(300, 430, 262, 342), X(T.back1 ?? 170), 234 + ((T.back1 ?? 170) - 110) * 0.27], [box(330, 460, 512, 592), X(T.back2 ?? 630), 462 + (690 - (T.back2 ?? 630)) * 0.27]];
      for (const [[a, y0, b, y1], tx, ty] of zones) {
        ctx.zone('reorg', a, y0, b, y1, { tx, ty, keep: T.keep ?? 0.4, cycle: { on: 0.45, off: 1.2 } });
      }
      ctx.peg(260, 700, 12); ctx.peg(540, 700, 12);
      ctx.seg(WALL_L, 750, 336, 900);
      ctx.seg(WALL_R, 750, 464, 900);
    },
  },
  {
    id: 'diamondhands',
    label: 'Diamond Hands',
    len: 900,
    build(ctx, rng) {
      // Claws in a pin field. A diamond-hands claw holds whatever it grabs
      // for 1.0-1.5s, a paper-hands one lets go after 0.2-0.6s. Each claw
      // opens and closes on its own beat, and grabs a marble once.
      ctx.seg(WALL_L, 20, 240, 100);
      ctx.seg(WALL_R, 20, 560, 100);
      const spots = [[250, 220], [550, 220], [330, 440], [470, 440]];
      const kinds = rng() < 0.5 ? [1, 0, 0, 1] : [0, 1, 1, 0];
      spots.forEach(([x, y], k) => {
        const diamond = kinds[k] === 1;
        ctx.zone('grab', x - 32, y - 24, x + 32, y + 24, {
          lo: diamond ? 1.0 : 0.2, hi: diamond ? 1.5 : 0.6, diamond, cycle: { on: 0.55, off: 0.9 } });
      });
      for (const [x, y] of [[400, 180], [180, 330], [400, 330], [620, 330], [250, 560], [550, 560]]) ctx.peg(x + rng.spread(5), y, 11);
      ctx.seg(WALL_L, 640, 336, 820);
      ctx.seg(WALL_R, 640, 464, 820);
    },
  },
  {
    id: 'sandwich',
    label: 'MEV Sandwich',
    len: 880,
    build(ctx, rng) {
      // Sandwich bots: pairs of bumpers that snap together round the gap you
      // are falling through (never quite shut, a marble always fits) and a
      // front-runner that darts across ahead of the field.
      ctx.seg(WALL_L, 20, 250, 100);
      ctx.seg(WALL_R, 20, 550, 100);
      for (const y of [220, 420, 600]) {
        const secs = rng.range(1.0, 1.6), period = Math.round(secs * 240), phase = Math.floor(rng() * period);
        const c = 400 + rng.spread(40);
        ctx.mover(c - 200, y, c - 56, y, { r: 22, secs, phase, kind: 'bot' });
        ctx.mover(c + 200, y, c + 56, y, { r: 22, secs, phase, kind: 'bot' });
      }
      ctx.mover(180, 320, 620, 320, { r: 14, secs: rng.range(0.8, 1.1), kind: 'runner' });
      ctx.seg(WALL_L, 680, 336, 840);
      ctx.seg(WALL_R, 680, 464, 840);
    },
  },
  {
    id: 'staking',
    label: 'Staking Vault',
    len: 900,
    build(ctx, rng) {
      // Two vaults, one each side, and a plain drop down the middle. A
      // marble that lands in a vault is LOCKED for 1s, then paid out with a
      // yield: fired hard across the course. Lock-up versus free fall, and
      // which is quicker depends on where the payout throws you.
      ctx.seg(WALL_L, 20, 250, 100);
      ctx.seg(WALL_R, 20, 550, 100);
      for (const x of [300, 400, 500]) ctx.peg(x + rng.spread(12), 170, 12);
      for (const side of [-1, 1]) {
        const cx = 400 + side * 250;
        ctx.seg(cx - side * 110, 250, cx - side * 20, 300);
        ctx.seg(cx - 60 * side, 360, cx, 390);
        ctx.seg(cx, 390, cx + 40 * side, 360);
        // `refire`: a payout that falls back into its own vault is paid out
        // again. Once-only, one marble in 100 sat in the vault for good.
        ctx.cannon(cx, 372, cx - side * 30, 340, -side * 620, 260, { kind: 'vault', delay: 1.0, gap: 40, refire: true });
      }
      for (const [x, y] of [[330, 470], [470, 470], [400, 560], [250, 590], [550, 590]]) ctx.peg(x + rng.spread(5), y, 12);
      ctx.seg(WALL_L, 660, 336, 840);
      ctx.seg(WALL_R, 660, 464, 840);
    },
  },
  {
    id: 'consensus',
    label: 'Consensus',
    len: 860,
    build(ctx, rng) {
      // The Mempool's tray of cups, but the floor is run by three validators,
      // each blinking green on its own beat. It drops while at least two of
      // three agree: consensus. Nobody waits long, and nobody knows when.
      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      for (let i = 0; i < 3; i++) ctx.peg(260 + i * 140 + rng.spread(10), 170, 12);
      const multi = [0, 1, 2].map(() => {
        const period = Math.round(240 * rng.range(0.8, 1.2));
        return { period, open: Math.round(period * 0.58), phase: Math.floor(rng() * period) };
      });
      const gate = { multi, need: 2, label: 'CONSENSUS' };
      const trayY = 320, cup = 100, x0 = 100, depth = 18;
      ctx.seg(WALL_L, trayY - 40, x0, trayY);
      ctx.seg(WALL_R, trayY - 40, x0 + 6 * cup, trayY);
      for (let i = 0; i < 6; i++) {
        const a = x0 + i * cup;
        ctx.seg(a, trayY, a + cup / 2, trayY + depth, { gate, tray: true });
        ctx.seg(a + cup / 2, trayY + depth, a + cup, trayY, { gate, tray: true });
      }
      ctx.hold(WALL_L, trayY - 80, WALL_R, trayY + depth + 20, gate);
      for (let row = 0; row < 2; row++) {
        const y = 450 + row * 90, n = row ? 4 : 5, span = row ? 130 : 120;
        const px = 400 - span * (n - 1) / 2 + rng.spread(8);
        for (let i = 0; i < n; i++) ctx.peg(px + i * span, y, 12);
      }
      ctx.seg(WALL_L, 640, 336, 820);
      ctx.seg(WALL_R, 640, 464, 820);
    },
  },
  {
    id: 'nftmint',
    label: 'NFT Mint',
    len: 960,
    build(ctx, rng) {
      // A capsule machine. The field is funnelled into a box with a spinner
      // inside, tumbled, and let out one draw at a time through a hatch in
      // the floor: the order it went in has nothing to do with the order it
      // comes out.
      ctx.seg(WALL_L, 30, 340, 170);
      ctx.seg(WALL_R, 30, 460, 170);
      ctx.seg(200, 200, 340, 200);
      ctx.seg(460, 200, 600, 200);
      ctx.seg(200, 200, 200, 520);
      ctx.seg(600, 200, 600, 520);
      ctx.rotor(400, 370, 118, { arms: 3, rps: (rng() < 0.5 ? -1 : 1) * 0.5, fr: 7, rest: 0.5 });
      ctx.seg(200, 520, 350, 575);
      ctx.seg(600, 520, 450, 575);
      const period = Math.round(240 * rng.range(0.7, 0.9));
      const gate = { period, open: 60, phase: Math.floor(rng() * period), label: 'MINT', wear: true };
      ctx.seg(350, 575, 450, 575, { gate, tray: true });
      ctx.hold(200, 200, 600, 590, gate);
      ctx.peg(300, 680, 12); ctx.peg(500, 680, 12);
      ctx.seg(WALL_L, 740, 336, 900);
      ctx.seg(WALL_R, 740, 464, 900);
    },
  },
  {
    id: 'moonshot',
    label: 'Moon Shot',
    len: 1100,
    build(ctx, rng) {
      // Split two ways. The left fork ends on a LAUNCHPAD: a countdown of
      // 0.2-0.9s, then the marble is fired straight up and comes down in the
      // exit funnel. The right fork rolls down a pair of ramps. Which is
      // faster depends on the countdown.
      ctx.seg(WALL_L, 20, 340, 130);
      ctx.seg(WALL_R, 20, 460, 130);
      ctx.dome(400, 190, 20);
      ctx.seg(400, 208, 400, 300);
      ctx.seg(385, 230, 160, 330);
      ctx.seg(415, 230, 650, 330);
      ctx.seg(WALL_R, 420, 540, 520);
      ctx.seg(560, 600, WALL_R, 690);
      // The pad: a cup low on the left.
      ctx.seg(WALL_L, 790, 180, 850);
      ctx.seg(180, 850, 260, 805);
      ctx.cannon(180, 830, 190, 800, 170, -1150, { kind: 'rocket', delay: 0.2, delayHi: 0.9, gap: 40, refire: true });
      ctx.seg(WALL_L, 920, 336, 1060);
      ctx.seg(WALL_R, 920, 464, 1060);
    },
  },
  {
    id: 'gravity',
    label: 'Whale Gravity',
    len: 920,
    // A STEADY well was showcase only, measured: weak enough never to trap a
    // marble in orbit, it barely bent a line (0.9 swaps); strong enough to
    // matter, it held marbles in orbit (4x the pull: 3410 nudges in 80
    // races). Sanjay's fix: a PULSE (see the engine's well): the pull builds,
    // holds and lets go, strongest for the first marble in. At 25x the old
    // pull, 200 races behind a spreading section: leader kept 78% -> 44%,
    // the first marble in takes 4.1s through it and the last 2.2s, 1 nudge.
    // The core is a pop bumper: a solid one let a marble the pull had pinned
    // on its crown sit there when the pulse ended.
    build(ctx, rng) {
      // From Antigravity's Gravity Slingshots: wells that PULL (1/r^2) but
      // never capture, round a solid core. A marble falling past one is bent
      // towards it, slung round it, or thrown off the far side, depending on
      // how close it came and how fast: a different line out for each.
      ctx.seg(WALL_L, 20, 260, 110);
      ctx.seg(WALL_R, 20, 540, 110);
      const G = TUNE.gravity || {};
      const flip = rng() < 0.5 ? -1 : 1;
      for (const [x, y] of [[400 - flip * 150, 280], [400 + flip * 150, 520]]) {
        const cx = x + rng.spread(20), R = G.rad ?? 190;
        if (!G.nocore) ctx.peg(cx, y, G.coreR ?? 26, { rest: G.coreRest ?? 1.15, whale: true });
        // Rise 0.25s, full pull to 1.2s, gone at 2.2s; each later marble
        // 0.55 of full less, never below 0.1.
        const pulse = G.off ? undefined : { rise: 0.25, hold: 1.2, end: 2.2, step: 0.55, floor: 0.1, ...G.pulse };
        ctx.zone('well', cx - R, y - R, cx + R, y + R, { cx, cy: y, rad: R, soft: 44, pull: G.pull ?? 3e8, pulse });
      }
      ctx.peg(400 + flip * 170, 380, 12); ctx.peg(400 - flip * 170, 640, 12);
      ctx.seg(WALL_L, 720, 336, 880);
      ctx.seg(WALL_R, 720, 464, 880);
    },
  },
  {
    id: 'hodl',
    label: 'HODL',
    len: 1020,
    build: (ctx, rng) => pegWords(ctx, rng, ['HO', 'DL'], 58, 8),
  },
  {
    id: 'gm',
    label: 'GM',
    len: 670,
    build: (ctx, rng) => pegWords(ctx, rng, ['GM'], 58, 8),
  },
  {
    id: 'wagmi',
    label: 'WAGMI',
    len: 950,
    build: (ctx, rng) => pegWords(ctx, rng, ['WAG', 'MI'], 51, 5),
  },
  {
    id: 'draw',
    label: 'The Draw',
    len: 860,
    opener: true,
    build(ctx, rng) {
      // THE OPENING. Measured, every section in the library handed the lead
      // to particular start slots when it came first: after the Bowl the
      // middle slot led 150 races in 150, after the Splitter the two walls,
      // after the Spiral the middle 95% of the time. The grid is the same
      // five spots every race, so a fixed opening maps slot to lead the same
      // way every race, and a bettor watching the grid can see it coming.
      //
      // So the opening is a peg board laid out FROM THE SEED: every peg lands
      // somewhere different each race, so which slot the board favours is
      // itself random, race by race. Short, and no funnel at the bottom: a
      // funnel lines the field up single file, and that single file is the
      // first gap of the race.
      const T = TUNE.draw || {};
      const rows = T.rows ?? 8, dy = T.dy ?? 75, per = T.per ?? 5;
      // Scattered, not a lattice: each peg anywhere in the playable width,
      // rejected only if a marble could not pass between it and another.
      // Pegs must keep MIN_GAP off the walls, which leaves a clear corridor
      // down each side, and the two wall slots fell straight down it and led
      // 38% of races each. Deflectors turn the wall lanes into the board.
      // Each deflector's reach drawn on its own, 110-300 (2026-09-26). One
      // shared reach of 150-215 always caught the two corner marbles and
      // never the two beside them: out of the Draw, slots 2 and 4 led 25%
      // each and the corners 16% (3000 races, chi 74). With the start grid
      // jittered and shifted too (see buildTrack), 19-21% each.
      const lo = T.llo ?? 110, hi = T.lhi ?? 300;
      const lip = T.lip ?? rng.range(lo, hi);
      const lipR = T.split === false ? lip : T.lip ?? rng.range(lo, hi);
      ctx.seg(WALL_L, 10, lip, 70 + (T.drop ?? 0));
      ctx.seg(WALL_R, 10, TRACK_W - lipR, 70 + (T.drop ?? 0));
      const placed = [];
      for (let r = 0; r < rows; r++) {
        for (let k = 0, got = 0; k < 30 && got < per - (r % 2); k++) {
          const x = rng.range(160, 640), y = 120 + r * dy + rng.spread(14);
          if (placed.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 < 72 * 72)) continue;
          placed.push([x, y]);
          ctx.peg(x, y, 12);
          got++;
        }
      }
      ctx.seg(WALL_L, 720, 200, 800);
      ctx.seg(WALL_R, 720, 600, 800);
    },
  },
  {
    id: 'safetycar',
    label: 'Safety Car',
    len: 900,
    showcase: true,
    build(ctx, rng) {
      // EXPERIMENT for Sanjay, not in the random pool: the Mempool's tray,
      // but the floor opens only when EVERY marble still racing is on it (or
      // 10s after the first arrived). A full reset of the gaps.
      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      for (let i = 0; i < 3; i++) ctx.peg(260 + i * 140 + rng.spread(10), 180, 12);
      const SC = TUNE.safetycar || {};
      const i = ctx.regroup(WALL_L, 250, WALL_R, 370, Math.round(240 * (SC.timeout ?? 10)), SC.need);
      const trayY = 330, cup = 100, x0 = 100, depth = 18;
      ctx.seg(WALL_L, trayY - 40, x0, trayY);
      ctx.seg(WALL_R, trayY - 40, x0 + 6 * cup, trayY);
      for (let k = 0; k < 6; k++) {
        const a = x0 + k * cup;
        ctx.seg(a, trayY, a + cup / 2, trayY + depth, { regroup: i });
        ctx.seg(a + cup / 2, trayY + depth, a + cup, trayY, { regroup: i });
      }
      for (let row = 0; row < 3; row++) {
        const y = 460 + row * 85, n = row % 2 === 0 ? 5 : 4, span = row % 2 === 0 ? 125 : 130;
        const px = 400 - (span * (n - 1)) / 2 + rng.spread(10);
        for (let k = 0; k < n; k++) ctx.peg(px + k * span, y, 12);
      }
      ctx.seg(WALL_L, 720, 336, 870);
      ctx.seg(WALL_R, 720, 464, 870);
    },
  },
  {
    id: 'mempool',
    label: 'The Mempool',
    len: 900,
    build(ctx, rng) {
      // THE REGROUP. Sanjay: "after half point it's certain which marble is
      // going to win". Measured, it was the field stringing out: first to last
      // 7.6s at a quarter distance, 12s by the end, and a marble 3s clear
      // cannot be caught by any amount of bumping. Mixing sections only mix a
      // field that is together.
      //
      // So: a tray of cups across the course, and the whole tray is a floor
      // that opens once per BLOCK, a fixed beat from the race clock. Whoever
      // arrives waits for the next block; when it comes everyone waiting drops
      // at the same instant, from the same height, into a peg field. A lead
      // built above the tray is gone. A marble that just misses the block
      // waits for the next one. It never looks at who is leading: it is a
      // clock, the same for every marble, like a safety car in F1.
      //
      // The cups matter. A plain V floor stacks the field in arrival order,
      // leader at the bottom, and the leader falls out first. Cups give every
      // marble its own spot at one height, so the drop is simultaneous.
      const T = TUNE.mempool || {};
      // A block every 1.0-1.5s, Sanjay's call: longer and the wait itself
      // is dead air. The cost is reach: it only regroups marbles already
      // within a block of each other, so it reshuffles close battles rather
      // than wiping a big lead.
      const period = Math.round(240 * rng.range(T.plo ?? 1.0, T.phi ?? 1.5));
      const gate = { period, open: T.open ?? 60, phase: Math.floor(rng() * period) };

      ctx.seg(WALL_L, 20, 230, 90);
      ctx.seg(WALL_R, 20, 570, 90);
      for (let row = 0; row < 2; row++) {
        const y = 150 + row * 80;
        const n = row === 0 ? 4 : 3;
        const span = row === 0 ? 140 : 150;
        const x0 = 400 - (span * (n - 1)) / 2 + rng.spread(12);
        for (let i = 0; i < n; i++) ctx.peg(x0 + i * span, y, 12);
      }

      // The tray: six cups, each a shallow V, all on the timed floor.
      const trayY = 330, cup = 100, depth = 18, x0 = 100;
      ctx.seg(WALL_L, trayY - 40, x0, trayY);
      ctx.seg(WALL_R, trayY - 40, x0 + 6 * cup, trayY);
      for (let i = 0; i < 6; i++) {
        const a = x0 + i * cup;
        ctx.seg(a, trayY, a + cup / 2, trayY + depth, { gate, tray: true });
        ctx.seg(a + cup / 2, trayY + depth, a + cup, trayY, { gate, tray: true });
      }
      ctx.hold(WALL_L, trayY - 80, WALL_R, trayY + depth + 20, gate);

      // Below: a peg field to scramble the release, then out.
      for (let row = 0; row < 3; row++) {
        const y = 460 + row * 85;
        const n = row % 2 === 0 ? 5 : 4;
        // 120, not 125: five at 125 plus the +-10 jitter put an end peg past
        // the wall clearance and the builder skipped it (1.6 pegs a course).
        const span = row % 2 === 0 ? 120 : 130;
        const px = 400 - (span * (n - 1)) / 2 + rng.spread(10);
        for (let i = 0; i < n; i++) ctx.peg(px + i * span, y, 12);
      }
      ctx.seg(WALL_L, 720, 336, 870);
      ctx.seg(WALL_R, 720, 464, 870);
    },
  },
  {
    id: 'blackhole',
    label: 'Event Horizon',
    len: 1100,
    hazard: true,
    build: (ctx, rng) => holeSection(ctx, rng, 'black'),
  },
  {
    id: 'whitehole',
    label: 'Wormhole',
    len: 1100,
    build: (ctx, rng) => holeSection(ctx, rng, 'white'),
  },
  {
    id: 'greyhole',
    label: 'Grey Zone',
    len: 1100,
    build: (ctx, rng) => holeSection(ctx, rng, 'grey'),
  },
];

/**
 * VARIANTS: the same machine with a different build, so the library is big
 * enough that a 58-block course rarely meets the same thing twice. Each is a
 * real change a viewer can see (more tiers, more cups, twin wheels, more
 * rows, stronger wind), not a mirror image, and each is benched like any
 * other section. `v` reaches the builder as ctx.v.
 */
const VARIANTS = [
  ['pachinko', 'pachislot', 'Pachislot', 980, { rows: 8, span: 110, r: 12, miss: 0.08 }],
  ['pachinko', 'pinstorm', 'Pin Storm', 1250, { rows: 12, span: 86, r: 8, miss: 0.15 }],
  ['coldstorage', 'deepfreeze', 'Deep Freeze', 900, { n: 5, on: 0.4, off: 1.8 }],
  ['coldstorage', 'frostbite', 'Frostbite', 900, { n: 2, on: 0.7, off: 1.2 }],
  ['crosswind', 'hurricane', 'Hurricane', 900, { force: 1700, swing: 0.7 }],
  ['crosswind', 'breeze', 'Sea Breeze', 900, { force: 1000, swing: 1.6 }],
  ['marketmakers', 'hft', 'High Frequency', 900, { rows: 5, lo: 0.9, hi: 1.6, r: 15 }],
  ['marketmakers', 'liquidity', 'Deep Liquidity', 900, { rows: 3, lo: 2.2, hi: 3.6, r: 24 }],
  ['slingshots', 'kickers', 'Kicker Alley', 900, { rows: 3 }],
  ['turnstiles', 'revolver', 'Revolving Door', 1000, { n: 1, R: 90, rps: 0.3 }],
  // Sanjay's retune (it was 3 four-arm turnstiles, 18.7s): three-arm, and
  // the arm tip kept 36 clear of the funnel lip so it cannot pinch a marble
  // there. 4.4s through, leader kept 40%, 0 nudges in 60.
  ['turnstiles', 'tollbooth', 'Toll Booth', 1000, { n: 3, arms: 3, rps: 0.6, clear: 36 }],
  // Four narrow vents that leave the peg field alone (the lean pushes a
  // marble off any crown it lands on, so the pegs can stay).
  ['geysers', 'hotsprings', 'Hot Springs', 920, { vents: [222, 292, 508, 578], half: 30, clear: 18, off: 0.9 }],
  ['geysers', 'oldfaithful', 'Old Faithful', 920, { vents: [400], force: 3800, off: 0.7 }],
  ['pinball', 'multiball', 'Multiball', 1560, { flippers: 3, pops: [[0, 180], [-120, 270], [120, 270], [0, 340]] }],
  ['plinko', 'megaplinko', 'Mega Plinko', 1300, { rows: 9, cups: 6 }],
  ['plinko', 'minijackpot', 'Quick Jackpot', 940, { rows: 4, cups: 4 }],
  ['whale', 'whales', 'Whale Pod', 1000, { ys: [300, 480], r: 48, end: 760 }],
  ['pistons', 'pumpjacks', 'Pumpjacks', 1000, { at: [[220, 200], [400, 260], [580, 200], [310, 430], [490, 430], [220, 640], [580, 640]], end: 780 }],
  ['miningwheel', 'twinwheels', 'Twin Wheels', 900, { twin: true }],
  ['bouncehouse', 'moonbounce', 'Moon Bounce', 1400, { rows: 5 }],
  ['firewall', 'ddos', 'DDoS Shield', 900, { n: 5 }],
  ['candles', 'candlestorm', 'Candle Storm', 900, { rows: 4 }],
  ['blizzard', 'whiteout', 'Whiteout', 960, { whiteout: true, force: 2300 }],
  ['looprow', 'tripleloop', 'Triple Loop', 2780, { forks: 3 }],
  ['wreckingballs', 'demolition', 'Demolition', 940, { n: 4, r: 32 }],
  ['cascade', 'liquiditypool', 'Liquidity Pool', 960, { tiers: 2, cups: 5 }],
  ['cascade', 'waterfall', 'Waterfall', 960, { tiers: 4, cups: 3 }],
  ['hashmill', 'grinder', 'The Grinder', 880, { arms: 4, lo: 0.8, hi: 1.2, rest: 0.8 }],
  ['zigzag', 'switchbacks', 'Switchbacks', 1000, { n: 4 }],
  ['updraft', 'thermals', 'Thermals', 940, { pegs: true, force: 2100 }],
  ['escalator', 'moving walkway', 'Moving Walkway', 960, { n: 3 }],
  ['airdrop', 'presale', 'Presale', 860, { cups: 4 }],
  ['airdrop', 'faucet', 'Faucet', 860, { cups: 5 }],
  ['lasergrid', 'lasermaze', 'Laser Maze', 1000, { n: 5, gap: 112 }],
  ['rugpull', 'bulltrap', 'Bull Trap', 900, { bull: true }],
];
for (const [base, id, label, len, v, showcase] of VARIANTS) {
  const b = SECTIONS.find(s => s.id === base);
  SECTIONS.push({ id: id.replace(/ /g, ''), label, len, v, base, build: b.build, hazard: b.hazard, showcase });
}

const BY_ID = Object.fromEntries(SECTIONS.map(s => [s.id, s]));

/**
 * What KIND of thing each section is, as a viewer sees it. Sanjay: "pinball
 * type elements are appearing more often than other elements". They were:
 * the finale drew only from the wildest 30% by measured swaps, and nearly
 * every one of those is a bumper board, so the run-in was wall-to-wall
 * pinball. The builder now spreads kinds out (see pickSections), and
 * tools/mix2d.js reports the mix so it stays measured.
 */
export const KIND = {};
const kinds = {
  bounce:  'pegs pachinko pachislot pinstorm popbumpers slingshots kickers pinball multiball bouncehouse moonbounce plinko megaplinko minijackpot springs flippers hodl gm wagmi',
  ramps:   'chutes serpent wedges humps gauntlet spiral splitter combs sprint stairs zigzag switchbacks bowl halving threechains loop looprow tripleloop',
  machine: 'windmills windfarm turbine hashmill grinder turnstiles tollbooth revolver miningwheel twinwheels wreckingballs demolition pistons pumpjacks marketmakers hft liquidity whale whales hopper sandwich',
  air:     'gravity crosswind hurricane breeze updraft thermals geysers hotsprings oldfaithful jetstream blizzard whiteout',
  trap:    'coldstorage deepfreeze frostbite gaslimit diamondhands staking consensus reorg rugpull bulltrap firewall ddos lasergrid lasermaze',
  belt:    'orderbook escalator movingwalkway',
  launch:  'cannons bridge moonshot airdrop presale faucet nftmint cascade liquiditypool waterfall',
  chart:   'chart dump flashcrash candles candlestorm',
  event:   'draw mempool safetycar gatehouse breach jump edge blackhole whitehole greyhole',
};
for (const [k, ids] of Object.entries(kinds)) for (const id of ids.split(' ')) KIND[id] = k;
for (const sct of SECTIONS) if (!KIND[sct.id]) KIND[sct.id] = KIND[sct.base] || 'other';

/** Sections found drawing outside their band (see buildTrack). Tests read it. */
export const OVERFLOW = [];

/* ---------------------------- assembly --------------------------------- */

const START_LEN  = 420;     // the pen above the gate
const RUNOUT_LEN = 420;     // finish line down to the basin floor

/**
 * Build a course.
 *
 * @param {object} rng    seeded rng; the SAME seed must give the SAME course
 * @param {object} opts
 * @param {string[]} [opts.only]   build exactly these ids, in this order
 * @param {number}   [opts.count]  how many sections to draw at random
 */
export function buildTrack(rng, opts = {}) {
  const out = { segments: [], bumpers: [], bowls: [], capsules: [], holes: [], flippers: [], springs: [], sensors: [], pits: [], openings: [], offtrack: [], holds: [], rotors: [], movers: [], zones: [], cannons: [], charts: [], regroups: [], signs: [] };

  const ids = opts.only && opts.only.length
    ? opts.only.filter(id => BY_ID[id])
    : pickSections(rng, opts.count ?? COURSE_BLOCKS);

  // ---- start pen ----
  const gateY = 360;
  // Wall to wall: the grid's shift and jitter (see `grid`) put a corner
  // marble anywhere from x 70 to 730, and a gate ending at 120/680 let it
  // fall off the end into the course before the start (38% of races).
  const gate = { ax: WALL_L, ay: gateY, bx: WALL_R, by: gateY };
  out.segments.push({ ax: WALL_L, ay: 0, bx: WALL_R, by: 0 });   // roof

  // ---- sections ----
  const bands = [];
  let y = START_LEN;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const s = BY_ID[id];
    const ctx = makeCtx(out, y, rng, i);
    ctx.v = s.v || {};
    const before = out.segments.length, pegsBefore = out.bumpers.length;
    const zonesBefore = out.zones.length, cannonsBefore = out.cannons.length;
    s.build(ctx, rng);
    // LATE WEAR: in the last part of a full course, holds and gate closed
    // spells wear from a bigger first-marble extra (x k), still running out
    // by the same marble. The finish is where a 75% leader is decided.
    // `cap` (seconds) keeps the first marble's whole wait under it: the
    // scale is cut per element to fit, never below today's wear.
    const L = TUNE.wear?.late;
    if (L && ids.length >= 20 && i / (ids.length - 1) >= L.from) {
      const HX = TUNE.wear.hold?.extra ?? 0, GU = TUNE.wear.gate?.up ?? 0;
      const fit = (base, extra) => !L.cap || !extra ? L.k : Math.max(1, Math.min(L.k, (L.cap - base) / extra));
      for (let k = zonesBefore; k < out.zones.length; k++) {
        const z = out.zones[k];
        if (z.kind === 'cryo' || z.kind === 'grab') z.wk = fit(z.kind === 'cryo' ? 2 : z.hi / 240, HX);   // a freeze is 2s
      }
      for (let k = cannonsBefore; k < out.cannons.length; k++) {
        const c = out.cannons[k];
        c.wk = fit((c.delayHi || c.delay) / 240, HX);
      }
      for (let k = before; k < out.segments.length; k++) {
        const g = out.segments[k].gate;
        if (g?.wear) { const closed = (g.period - g.open) / 240; g.wk = fit(closed, closed * GU); }
      }
    }
    // A section must stay inside its own band. One that draws past its end
    // lands its exit on the NEXT section's entrance, and the two together can
    // make a pocket neither makes alone: the word boards did exactly that, and
    // 41 races in 300 never finished. Invisible on the single-section bench,
    // where the offender is always last.
    for (let k = before; k < out.segments.length; k++) {
      const g = out.segments[k];
      if (Math.max(g.ay, g.by) > y + s.len + 2 || Math.min(g.ay, g.by) < y - 2) {
        OVERFLOW.push(`${id}: wall at y ${(Math.min(g.ay, g.by) - y).toFixed(0)}..${(Math.max(g.ay, g.by) - y).toFixed(0)} outside 0..${s.len}`);
        break;
      }
    }
    for (let k = pegsBefore; k < out.bumpers.length; k++) {
      const b = out.bumpers[k];
      if (b.y + b.r > y + s.len + 2 || b.y - b.r < y - 2) { OVERFLOW.push(`${id}: peg at y ${(b.y - y).toFixed(0)} outside 0..${s.len}`); break; }
    }
    // A worn pop bumper's grown size must leave a marble room to pass every
    // ramp and pad, or it pokes through a ramp it sat just under and makes a
    // pocket with it (Bounce House: 11 stuck marbles in 800 races at one
    // spot). Grow only into clear space.
    for (let k = pegsBefore; k < out.bumpers.length; k++) {
      const b = out.bumpers[k];
      if (!b.growWant) continue;
      let g = b.growWant;
      const near = (ax, ay, bx, by) => {
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        let u = ((b.x - ax) * dx + (b.y - ay) * dy) / l2; u = u < 0 ? 0 : u > 1 ? 1 : u;
        return hyp(b.x - ax - u * dx, b.y - ay - u * dy);
      };
      for (let j = before; j < out.segments.length; j++) {
        const q = out.segments[j];
        g = Math.min(g, near(q.ax, q.ay, q.bx, q.by) - b.r - 36);
      }
      for (const q of out.springs) g = Math.min(g, near(q.ax, q.ay, q.bx, q.by) - b.r - 36);
      // ...and every other peg, some of which may have grown already.
      for (const o of out.bumpers) if (o !== b) g = Math.min(g, hyp(o.x - b.x, o.y - b.y) - b.r - o.r - 38);
      g = Math.max(0, Math.floor(g));
      if (g > 0) { b.min = b.r; b.r += g; b.wear = b.wearStep; }
      delete b.growWant; delete b.wearStep;
    }
    bands.push({ id, name: s.label, y0: y, y1: y + s.len });
    y += s.len;
  }

  // ---- warp destinations, now that every section has a place ----
  //
  // A warp is worth about THREE SECONDS, not a number of sections. Measured
  // over 30 full-length races: neighbouring finishers are a median 3.2s
  // apart and first to last 14.3s. The first version sent a marble two whole
  // sections, about 7s, half the field's entire spread: enough on its own to
  // carry the last marble to the front or bury the leader. Sanjay's call. At
  // ~3s a warp typically swaps a marble with its neighbour, sometimes two
  // places, and never decides a race by itself.
  const top = bands[0].y0, bottom = bands[bands.length - 1].y1 - 200;
  for (const h of out.holes) {
    if (h.kind === 'black') continue;
    const at = (dir) => {
      const want = Math.max(top, Math.min(bottom, h.y + dir * WARP_UNITS));
      const p = findDrop(out, { y0: want, y1: want + 400 });
      return { ...p, secs: Math.round((p.y - h.y) / PACE) };
    };
    h.ahead = at(1);
    h.behind = at(-1);
  }

  // ---- finish and basin ----
  const finishY = y + 120;
  const basinY  = finishY + RUNOUT_LEN;
  out.segments.push({ ax: WALL_L, ay: basinY, bx: WALL_R, by: basinY });
  const height = basinY + 140;

  // Side walls last, spanning everything, so nothing can leave sideways,
  // except through an opening (The Edge), which the wall is built around.
  for (const side of [-1, 1]) {
    const x = side < 0 ? WALL_L : WALL_R;
    const gaps = out.openings.filter(o => o.side === side).sort((a, b) => a.y0 - b.y0);
    let from = 0;
    for (const g of gaps) {
      out.segments.push({ ax: x, ay: from, bx: x, by: g.y0 });
      from = g.y1;
    }
    out.segments.push({ ax: x, ay: from, bx: x, by: height });
  }

  return {
    width: TRACK_W, height,
    wallL: WALL_L, wallR: WALL_R,
    segments: out.segments,
    bumpers: out.bumpers,
    bowls: out.bowls,
    capsules: out.capsules,
    holes: out.holes,
    flippers: out.flippers,
    springs: out.springs,
    sensors: out.sensors,
    pits: out.pits,
    openings: out.openings,
    offtrack: out.offtrack,
    holds: out.holds,
    rotors: out.rotors,
    movers: out.movers,
    zones: out.zones,
    cannons: out.cannons,
    charts: out.charts,
    regroups: out.regroups,
    signs: out.signs,
    gate, finishY, basinY,
    sections: bands,
    layout: ids,
    // Timed wear is an engine rule for every hold on the course, so it rides
    // on the track (and with it to every viewer) rather than per element.
    wear: TUNE.wear?.hold || TUNE.wear?.gate ? { hold: TUNE.wear.hold && { ...TUNE.wear.hold }, gate: TUNE.wear.gate && { ...TUNE.wear.gate } } : undefined,
    grid: {
      // The whole grid shifts +-30 with the course, and each marble +-30 on
      // it, so no start slot sits in the same place against the opener twice.
      // 90 apart, from 220: the corner slots start 130+ from the walls. At
      // 125 apart they started as near as 30 and led out of every opener
      // 15-17% (the openers funnel to the middle, so the outermost marble has
      // the furthest to go); at 90, Plinko 20/21/19/21/19.
      x0: (TUNE.grid?.x0 ?? 220) + rng.spread(TUNE.grid?.shift ?? 30), dx: TUNE.grid?.dx ?? 90, y0: gateY - 70, stagger: 40, jitter: TUNE.grid?.jitter ?? 30,
      count: MARBLE_DATA.length,
    },
  };
}

/**
 * Somewhere near the top of a section a warped marble can safely appear.
 *
 * Scans a grid of candidate points from the top of the band down, centre
 * outwards, and takes the first that is clear of EVERYTHING: walls on any
 * layer, pegs, islands, bowl rings, spring pads, flipper sweeps, pits, and
 * the pull of every hole, so a marble can never be dropped inside geometry or
 * straight into another hole. Deterministic, like the rest of the build.
 */
function findDrop(out, band) {
  const CLEAR = 30;
  const seg2 = (x, y, s) => {
    const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy || 1;
    let u = ((x - s.ax) * dx + (y - s.ay) * dy) / l2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const ex = x - s.ax - u * dx, ey = y - s.ay - u * dy;
    return ex * ex + ey * ey;
  };
  const ok = (x, y) =>
    out.segments.every(s => seg2(x, y, s) >= CLEAR * CLEAR) &&
    out.springs.every(s => seg2(x, y, s) >= CLEAR * CLEAR) &&
    out.bumpers.every(b => (x - b.x) ** 2 + (y - b.y) ** 2 >= (b.r + CLEAR) ** 2) &&
    out.capsules.every(c => seg2(x, y, c) >= (c.r + CLEAR) ** 2) &&
    out.bowls.every(b => Math.abs(Math.sqrt((x - b.x) ** 2 + (y - b.y) ** 2) - b.R) >= CLEAR) &&
    // A sweeping hole can be anywhere along its sweep.
    out.holes.every(h => Math.max(0, Math.abs(x - h.x0) - (h.sway || 0)) ** 2 + (y - h.y) ** 2 >= (h.pull + CLEAR) ** 2) &&
    out.flippers.every(f => (x - f.px) ** 2 + (y - f.py) ** 2 >= (f.len + CLEAR) ** 2) &&
    out.rotors.every(o => (x - o.cx) ** 2 + (y - o.cy) ** 2 >= (o.len + o.fr + CLEAR) ** 2) &&
    out.movers.every(o => seg2(x, y, { ax: o.ax, ay: o.ay, bx: o.bx, by: o.by }) >= (o.r + CLEAR) ** 2) &&
    out.zones.every(z => z.kind === 'fan' || x < z.x0 - CLEAR || x > z.x1 + CLEAR || y < z.y0 - CLEAR || y > z.y1 + CLEAR) &&
    out.cannons.every(c => (x - c.x) ** 2 + (y - c.y) ** 2 >= (c.catch + CLEAR) ** 2) &&
    out.pits.every(p => x < p.x0 - CLEAR || x > p.x1 + CLEAR || y < p.y0 - 200 || y > p.y1 + CLEAR);
  // Off the centre line on purpose: sections are symmetric about x=400, so
  // that is exactly where a peg crown or a cup rim sits.
  const xs = [411, 369, 451, 329, 491, 289, 531, 249, 571, 209, 611];
  for (let dy = 20; dy < band.y1 - band.y0; dy += 20) {
    for (const x of xs) if (ok(x, band.y0 + dy)) return { x, y: band.y0 + dy };
  }
  return { x: 400, y: band.y0 + 20 };        // unreachable on any section in the library
}

/** Sections that can knock a marble out, and sections that warp one. */
const KNOCKOUT = ['blackhole', 'jump', 'edge', 'breach'];
const WARPS = ['whitehole', 'greyhole'];
/** Every-race randomisers that are neither: cost or save time, never a knockout. */
const REGULARS = ['gatehouse'];

/**
 * Draw a course order from the library: THE COURSE BUILDER.
 *
 * Sanjay: "after half point it's certain which marble is going to win", and
 * "make our track building intelligent". Measured, three things made races
 * go dead, and each rule below answers one of them. What a section does to a
 * field is not guessed: tools/library2d.js benches every section and writes
 * js/sectionStats.js (swaps: pairs that change order through it, of 10;
 * grow: seconds it spreads the field by), and this reads that table.
 *
 *   1. THE START handed the lead to a lane. Every section in the library,
 *      placed first, mapped start slot to leader (the Bowl: the middle slot
 *      150 races in 150). The Draw, a peg board laid out from the seed, is
 *      measured fair, and it always opens.
 *   2. THE FIELD STRUNG OUT: 12s first to last by the end, and no section can
 *      swap marbles 3s apart. The Mempool (a tray that drops everyone on a
 *      1.0-1.5s block) goes in around halfway and again before the finale.
 *   3. THE ENDING was a sprint, and the order at the sprint was the result.
 *      The last stretch is now drawn ONLY from the strongest measured
 *      shufflers (high swaps, low spread), and the weakest ones are kept to
 *      the opening third, where a lost place can still be won back.
 *
 * Events are still PLACED, not drawn (1-3 knockout hazards, a white and a
 * grey hole and sometimes a third, 1-2 gatehouses), and no section appears
 * twice in a course, nor within three blocks of another from its family.
 * None of this looks at who is leading: it is all decided from the seed
 * before the race, and it is the same course whoever wins.
 */
const OPENER = 'draw', REGROUP = 'mempool';
/**
 * Sections that may OPEN a course, drawn at random each race (Sanjay: why is
 * the start not randomised like the rest?). Only sections measured to hand
 * the early lead out evenly by start slot qualify.
 *
 * Re-measured 2026-09-27, after the start gate was made wall to wall: the
 * first measurements (Draw 21/20/18/20/21 and so on) were flattered by a
 * corner marble falling off the old gate's end before the start in 38% of
 * races. With every marble really on the gate, the Draw (chi 21, 4000
 * races), Liquidity Cascade (16+), Airdrop (124), Liquidity Pool (50), Quick
 * Jackpot (27) and Waterfall (15) all favour the slots beside the corners.
 * The two that pass end in five or six cups on their own random timers,
 * which is what evens a head start out: Plinko Jackpot 20/21/19/21/19 (chi
 * 5.8, 4000 races) and Mega Plinko 21/20/18/21/20 (chi 7.3, 3000), both on
 * the narrower grid in buildTrack. Earlier rejects: fixed peg layouts
 * (Validator Nodes corners 36% and 32%) and both lasers (corners 23 vs 17%).
 */
const OPENERS = ['plinko', 'megaplinko'];

function pickSections(rng, count) {
  const body = Math.max(3, count - 1);                  // slot 0 is the opener
  const slots = new Array(body).fill(null);

  // `ids` is a list to draw from per placement, or an exact list to place.
  const scatter = (ids, n, lo, hi, exact = false) => {
    const a = Math.max(0, Math.floor(lo * body)), b = Math.max(a + 1, Math.floor(hi * body));
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 50; tries++) {
        const i = a + Math.floor(rng() * (b - a));
        if (slots[i] || slots[i - 1] || slots[i + 1]) continue;
        slots[i] = exact ? ids[k] : ids[Math.floor(rng() * ids.length)];
        break;
      }
    }
  };
  const FINALE = 0.82;
  if (body >= 8) {
    // Big randomisers belong in the second half: a 3s warp at 20% is just
    // more spread by the end; at 80% it is a result changing hands.
    scatter(KNOCKOUT, [1, 2, 2, 3][Math.floor(rng() * 4)], 0.3, 0.95);
    const warps = ['whitehole', 'greyhole'];
    if (rng() < 0.35) warps.push(WARPS[Math.floor(rng() * WARPS.length)]);
    scatter(warps, warps.length, 0.45, 0.95, true);
    scatter(REGULARS, 1 + Math.floor(rng() * 2), 0.35, 0.95);
    // Regroups: one around halfway, one just before the finale.
    scatter([REGROUP], 1, 0.42, 0.6, true);
    scatter([TUNE.director?.safetycar ? 'safetycar' : REGROUP], 1, 0.7, FINALE - 0.02, true);
    // A whale's pulse well placed late (TUNE.lateGravity {lo, hi}).
    const LG = TUNE.lateGravity;
    if (LG) scatter(['gravity'], 1, LG.lo, LG.hi, true);
  }

  const opener = TUNE.opener ?? OPENERS[Math.floor(rng() * OPENERS.length)];
  const special = new Set([...KNOCKOUT, ...WARPS, ...REGULARS, OPENER, REGROUP, opener]);
  const stat = (id) => SECTION_STATS[id] || { swaps: 1.5, grow: 1, secs: 3, nudge: 0 };
  const family = (id) => BY_ID[id].base || id;
  const pool = SECTIONS.filter(s => !special.has(s.id) && !s.showcase && stat(s.id).nudge <= 0.05 && !TUNE.exclude?.includes(s.id)).map(s => s.id);
  // Measured the other way first, and it was backwards: putting the
  // sections that shuffle WITHOUT spreading at the end left the field strung
  // out 16s by then, with the leader at halfway winning 49%. Spread made early
  // is the enemy (nobody can close a 5s gap); variance made LATE is the
  // drama. So: the calmest sections (least spread) early, the wildest
  // (most swaps plus most spread) in the finale.
  const wild = (id) => stat(id).swaps + 0.5 * Math.max(0, stat(id).grow);
  const byWild = pool.slice().sort((x, y) => wild(y) - wild(x));
  const top = new Set(byWild.slice(0, Math.round(byWild.length * 0.3)));     // finale material
  const byCalm = pool.slice().sort((x, y) => stat(x).grow - stat(y).grow);
  const calm = new Set(byCalm.slice(0, Math.round(byCalm.length * 0.55)));  // opening half

  const used = new Set(slots.filter(Boolean));
  let slow = 0;
  for (let i = 0; i < body; i++) {
    if (slots[i]) continue;
    const f = i / (body - 1);
    // The opener sits just before slot 0: it counts as a neighbour there.
    const before = [opener, ...slots];
    const around = before.slice(Math.max(0, i + 1 - 3), i + 1).concat(slots.slice(i + 1, i + 4)).filter(Boolean);
    const near = new Set(around.map(family));
    // KIND spacing: never two of a kind back to back, and at most two of a
    // kind in any seven blocks, so the run-in is not all bumper boards.
    const kindNear = (id) => !TUNE.mix?.off && (KIND[before[i]] === KIND[id] || KIND[slots[i + 1]] === KIND[id] ||
      around.filter(x => KIND[x] === KIND[id]).length >= (TUNE.mix?.perSeven ?? 1));
    const ok = (id) => !used.has(id) && !near.has(family(id)) && !kindNear(id) && !(stat(id).secs > 7 && slow >= 2);
    let can;
    if (f >= FINALE) can = pool.filter(id => top.has(id) && ok(id));
    else if (f >= 0.55) can = pool.filter(id => !calm.has(id) || top.has(id) ? ok(id) : false);
    else can = pool.filter(id => calm.has(id) && !top.has(id) && ok(id));
    if (!can.length) can = pool.filter(ok);
    if (!can.length) can = pool.filter(id => !used.has(id) && !near.has(family(id)) && (TUNE.mix?.off || KIND[before[i]] !== KIND[id]));
    if (!can.length) can = pool.filter(id => !near.has(family(id)));
    const id = can[Math.floor(rng() * can.length)];
    slots[i] = id; used.add(id);
    if (stat(id).secs > 7) slow++;
  }
  return [opener, ...slots];
}
