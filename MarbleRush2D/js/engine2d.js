// engine2d.js: The 2D race. Authoritative, deterministic, headless.
//
// Same contract as the 3D js/race.js: no DOM, no canvas, no audio, no UI, so
// it runs identically in the page and in Node. The server decides the race,
// the browser replays it. A parimutuel pool settled from a race the client
// simulated is a race the client can tamper with.
//
// Grown from the author's own first 2D prototype (`enginejs2D.ts`, made in Lovable). What
// was taken, and what had to change:
//
// TAKEN, the collision model, which is the best thing about it.
//   A circle against a line segment, resolved by closest point, has NO CORNERS
//   anywhere: the closest point on a segment moves continuously as the marble
//   moves, so there is no discontinuity for a marble to lodge in. The 3D build
//   lost days to exactly that problem, cannon-es box barriers meeting a side
//   rail give three mutually perpendicular planes, and a sphere in that corner
//   is a solver fixed point. We worked around it with raked walls, clearance
//   rules and dense sphere chains. In 2D the whole class of bug is simply gone.
//   The bowl-with-angular-gaps is also theirs, and it is the one element that
//   genuinely reshuffles running order.
//
// CHANGED, everything that made it unusable for a betting product.
//   1. `step(rawDt)` took a frame delta and then ran `ceil(dt / (1/240))`
//      substeps of size `dt/steps`. Both the COUNT and the SIZE of the
//      substeps varied with frame rate, so the same race never ran twice.
//      Here the tick is fixed and the caller accumulates.
//   2. `Math.random()` seeded the grid jitter. Now the seeded rng does, in a
//      fixed marble order.
//   3. Particles lived in the engine. They are cosmetic, they cost Node time,
//      and they were an unseeded random source in the authoritative loop.
//      The engine records that a bumper was struck; the renderer makes sparks.
//   4. No transcendentals in the hot loop. `Math.hypot` and `Math.exp` are
//      library calls whose last bit may differ between one V8 and another, and
//      the browser and the server are not the same V8. Plain sqrt and linear
//      drag are exact arithmetic.
//   5. Standings read raw `m.y`, which is not monotonic, a marble bouncing
//      upward would flicker down the board. Progress here only ever increases.
//   6. No stall detection at all. A marble resting in a V between two segments
//      sits there forever and the race never ends.
//
// FEEL, "real rolling plus reshufflers", per Sanjay.
//   Wall contacts decompose velocity into normal and tangent: restitution on
//   the normal so it rolls rather than bounces, friction on the tangent so it
//   sheds speed the way a real marble does. The prototype multiplied BOTH
//   components by 0.998 on contact, which is neither restitution nor friction
//   and is why everything skated. Bumpers keep their high restitution, they
//   are the arcade element and they are what shuffles the order.

/** Fixed simulation tick. Must not vary: the result is part of the payout. */
export const SIM_DT = 1 / 240;

/** The course is authored in a fixed-width world and scaled to fit on screen. */
export const TRACK_W = 800;

/* ------------------------------- tuning -------------------------------- */
const GRAVITY       = 1500;
const AIR_DRAG      = 0.12;   // per second, applied linearly
const MAX_SPEED     = 1700;

const REST_WALL     = 0.22;   // low, so marbles run the wall instead of bouncing
// ROLLING resistance, not sliding friction, and the difference decides whether
// the course works at all. These are marbles: they roll, and rolling
// resistance for glass on wood is a few hundredths, where sliding friction
// would be 0.2-0.4. Using a sliding value froze the field on every shallow
// ramp, because a slope only moves a body when tan(theta) exceeds mu, at
// mu 0.26 nothing below 15 degrees moves at all, and "The Grooves" is 11.7.
// Rotation is not simulated, so this coefficient is the one place that fact
// has to be paid for.
const MU_WALL       = 0.06;
const REST_BUMPER   = 0.88;   // high, on purpose: bumpers are the reshuffler
const MU_BUMPER     = 0.04;
const REST_BOWL     = 0.30;
const MU_BOWL       = 0.08;   // the ring is nearly flat at its floor: see MU_WALL
const REST_MARBLE   = 0.45;
const REST_GATE     = 0.10;
const REST_FLIP     = 0.30;

/**
 * Flipper stroke, in TICKS rather than seconds so the timing is an integer
 * count and never a float that has been accumulated. At 240 Hz: 0.07s up,
 * 0.12s held, 0.25s back, then 0.40s before it can fire again.
 *
 * The cooldown is what makes a flipper uncertain rather than a machine. A
 * marble that lands while it is still recovering from the previous one rolls
 * straight off the end unkicked, so whether YOU get thrown depends on who
 * arrived just before you.
 */
const FLIP_UP = 17, FLIP_HOLD = 29, FLIP_DOWN = 60, FLIP_COOL = 96;
const FLIP_END = FLIP_UP + FLIP_HOLD + FLIP_DOWN + FLIP_COOL;

/** A spring pad recharges for this many ticks (0.35s) after it fires. */
const SPRING_COOL = 84;

const MARBLE_R      = 16;

/**
 * The most marbles hazards may knock out of one race.
 *
 * Two, from five, and the number is chosen against the payout rather than the
 * spectacle. Top 2 are paid, so capping knockouts at 2 guarantees at least 3
 * finishers, and therefore that BOTH paid places always go to marbles that
 * actually crossed the line. "You are only ever paid on a finisher" is a rule
 * a bettor can hold in their head; the alternative, paying second place to
 * whichever marble was eaten last, is not.
 *
 * Once the cap is reached every hazard on the course DISARMS for the rest of
 * the race, visibly: black holes collapse into inert domes and pits grow a
 * safety net. Nothing is hidden from the viewer about why a marble survived.
 */
export const MAX_OUT = 2;

/** How long a marble may fail to MOVE before it is nudged back into the race. */
export const STUCK_LIMIT = 2.2;

/** How much a worn flipper shortens per tick at rest, world units. */
const FLIP_SHRINK = 0.5;


/**
 * Height of one band of the broad-phase index, in world units.
 *
 * The course only ever gets taller, never wider, so a 1D index on y is all the
 * broad phase needs. See `_index()`.
 */
const BAND = 256;
/**
 * How far past its own extent an obstacle is filed, so no contact is missed.
 *
 * The band is chosen once per tick from where the marble is BEFORE collisions
 * push it about. A push is at most the penetration depth, which is bounded by
 * one tick of travel (MAX_SPEED / 240 ~= 7) plus a marble's radius when the
 * field is stacked. 72 is more than twice that, which costs a few extra
 * candidates and buys never having to think about it again.
 */
const REACH = 72;

/** Pre-race settling, in ticks. Fixed, so every run starts from one state. */
export const SETTLE_TICKS = 240;
const STUCK_MOVE    = 20;     // world units that count as "it is still going"
const LOITER_TICKS  = 8 * 240; // no new progress down the course for this long: trapped

/* ------------------------------ helpers -------------------------------- */

/**
 * Deterministic sine and cosine: +, -, *, / only.
 *
 * Math.sin is NOT specified to the bit, and two JavaScript engines may round
 * it differently, which is how a verifier re-running a race gets a different
 * winner. Rotating things (windmills) need angles every tick, so they get
 * their own: reduce to [-pi/2, pi/2], then a Taylor series to x^13, good to
 * about 1e-9 there. Exactly the same result everywhere.
 */
const PI = 3.141592653589793, TAU = 2 * PI;
export function dsin(x) {
  x = x - Math.floor(x / TAU) * TAU;            // 0 .. TAU
  if (x > PI) x -= TAU;                          // -PI .. PI
  if (x > PI / 2) x = PI - x;
  else if (x < -PI / 2) x = -PI - x;
  const x2 = x * x;
  return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110 * (1 - x2 / 156))))));
}
export function dcos(x) { return dsin(x + PI / 2); }

/** A smooth back-and-forth, -1..1, from the integer tick: eased triangle wave. */
export function glide(tick, period, phase) {
  const u = ((tick + phase) % period) / period;
  const t = u < 0.5 ? u * 4 - 1 : 3 - u * 4;
  return (3 * t - t * t * t) / 2;
}

/**
 * A number in [0, 1) that looks random but is fixed by (tick, salt): for hold
 * lengths that should differ marble to marble without drawing on the race rng
 * (which would change every race that has no such element). Integer hashing,
 * exact everywhere.
 */
export function tickNoise(tick, salt) {
  let h = (tick * 2654435761 + salt * 97531) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** How long a cryo trap holds a marble, in ticks (2 seconds). */
export const FREEZE_TICKS = 480;

/** Squared distance from (x, y) to the segment a-b. */
function distSeg2(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let u = len2 > 1e-9 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const ex = x - (ax + u * dx), ey = y - (ay + u * dy);
  return ex * ex + ey * ey;
}

/**
 * Resolve a contact whose outward normal is (nx, ny), already unit length.
 *
 * Restitution acts on the normal component; friction is COULOMB, the
 * tangential impulse is capped at `mu` times the normal impulse.
 *
 * That cap is the whole point, and getting it wrong stopped the field dead.
 * The first version, and the prototype, scaled the tangential velocity
 * by a constant on every contact. But a marble resting on a ramp is in contact
 * on EVERY tick, so at 240 Hz a 0.16 shave compounds to nothing in a few
 * hundredths of a second: the marble freezes on a slope it should roll down,
 * and the stall detector then has to shove it along the entire course. Every
 * section in the library failed this way, including a run-in that is three
 * deflectors and a floor.
 *
 * With a Coulomb cap the normal impulse while resting is only what cancels one
 * tick of gravity, so the friction available is proportionally tiny and
 * gravity's along-slope component wins, which is exactly how a real marble
 * behaves. On a hard strike the normal impulse is large, so friction can
 * properly bite.
 */
function resolve(m, nx, ny, rest, mu) {
  const vn = m.vx * nx + m.vy * ny;
  if (vn >= 0) return false;                 // already separating

  const tx = -ny, ty = nx;                   // unit tangent
  const vt = m.vx * tx + m.vy * ty;

  const jn = -(1 + rest) * vn;               // normal impulse, per unit mass
  const cap = mu * jn;
  let jt = -vt;                              // what would stop tangential motion
  if (jt >  cap) jt =  cap;
  if (jt < -cap) jt = -cap;

  m.vx += nx * jn + tx * jt;
  m.vy += ny * jn + ty * jt;

  // Visual spin only. Nothing reads this back into the physics, so it cannot
  // affect a result; it exists so the renderer can roll the marble's pattern.
  m.spin = -(vt + jt) / m.r;
  return true;
}

/* ------------------------------- engine -------------------------------- */

export class Engine2D {
  /**
   * @param {object}   opts
   * @param {object}   opts.track    from track2d.js buildTrack()
   * @param {object}   opts.rng      seeded rng from js/rng.js
   * @param {Array}    opts.racers   MARBLE_DATA; index is the racer id
   */
  constructor({ track, rng, racers }) {
    this.track = track;
    this.racers = racers;
    this.marbles = racers.map((data, index) => ({
      index, data,
      x: 0, y: 0, vx: 0, vy: 0, r: MARBLE_R, spin: 0,
      finished: false, finishTime: 0,
      progress: 0,
      out: false, outTime: 0, outBy: '', layer: 0,
      stuckX: 0, stuckY: 0, stuckTime: 0, wellUntil: 0,
    }));
    this._index();
    this.reset(rng);
  }

  /**
   * Broad phase: file every static obstacle under the y-bands it can touch.
   *
   * Without this every marble tests every wall on the course every tick, so
   * the cost of a race grows with the LENGTH of the course times its duration,
   * which is quadratic in length. A 60-block course took 1.3s to precompute
   * and a 3-4 minute race would have been several seconds of frozen page when
   * the round opens.
   *
   * RESULTS ARE UNCHANGED, bit for bit, and that is a property of how it is
   * built rather than a hope. Every contact routine returns without touching
   * anything when there is no contact, so leaving out an obstacle that cannot
   * be touched is invisible. And each band lists its obstacles in their
   * ORIGINAL order, so the ones that ARE tested are resolved in the same
   * sequence as before, which matters because contacts resolved in a
   * different order produce different floating-point results. Verified
   * against recorded races: final positions identical to the last bit.
   */
  _index() {
    const t = this.track;
    const n = Math.ceil((t.height + 2 * BAND) / BAND) + 1;
    const make = () => Array.from({ length: n }, () => []);
    const file = (lists, i, y0, y1) => {
      const a = Math.max(0, Math.floor((y0 - REACH + BAND) / BAND));
      const b = Math.min(n - 1, Math.floor((y1 + REACH + BAND) / BAND));
      for (let k = a; k <= b; k++) lists[k].push(i);
    };

    this._bSeg = make();
    t.segments.forEach((s, i) => s.door
      ? file(this._bSeg, i, s.door.y0 - s.door.len, s.door.y1)
      : file(this._bSeg, i, Math.min(s.ay, s.by), Math.max(s.ay, s.by)));
    this._bCap = make();
    t.capsules.forEach((c, i) => file(this._bCap, i, Math.min(c.ay, c.by) - c.r, Math.max(c.ay, c.by) + c.r));
    this._bBowl = make();
    // A bowl acts out to R + 80 (see `_bowl`), not R: file it that wide.
    t.bowls.forEach((b, i) => file(this._bBowl, i, b.y - b.R - 80, b.y + b.R + 80));
    this._bPeg = make();
    t.bumpers.forEach((p, i) => file(this._bPeg, i, p.y - p.r, p.y + p.r));
    // A worn bumper's live radius (see peg() in track2d), and who has hit it.
    this.pegR = Float64Array.from(t.bumpers, p => p.r);
    this.pegHit = new Int32Array(t.bumpers.length);
    this._bHole = make();
    (t.holes || []).forEach((h, i) => file(this._bHole, i, h.y - h.pull, h.y + h.pull));
    // A flipper sweeps a disc of its own length about the pivot.
    this._bFlip = make();
    (t.flippers || []).forEach((f, i) => file(this._bFlip, i, f.py - f.len - f.fr, f.py + f.len + f.fr));
    // Its live pose, recomputed every tick. Dynamic state belongs to the
    // ENGINE, not the track, so two engines built from one course can never
    // share it, and restore() can put it back.
    // Sliding doors: segments that MOVE along their own line. Filed over their
    // whole travel, and remembered so they can be moved each tick.
    this._doorSegs = [];
    t.segments.forEach((s, i) => { if (s.door) this._doorSegs.push(s); });
    this._bSpring = make();
    (t.springs || []).forEach((p, i) => file(this._bSpring, i, Math.min(p.ay, p.by), Math.max(p.ay, p.by)));
    this.pads = (t.springs || []).map(() => ({ tick: -1, used: 0, gone: false }));
    // Which marbles each hole has already warped: white and grey holes take a
    // given marble at most once, so a marble sent back can never be caught in
    // a loop at the same hole.
    this.holeUsed = (t.holes || []).map(() => 0);
    this._swayHoles = (t.holes || []).filter(o => o.sway);
    // Windmills: arms turning about a hub. Filed over the disc they sweep.
    this._bRotor = make();
    (t.rotors || []).forEach((o, i) => file(this._bRotor, i, o.cy - o.len - o.fr, o.cy + o.len + o.fr));
    // Moving bumpers: filed over their whole path.
    this._bMover = make();
    (t.movers || []).forEach((o, i) => file(this._bMover, i, Math.min(o.ay, o.by) - o.r, Math.max(o.ay, o.by) + o.r));
    // Zones: fans, updrafts, cryo traps, speed traps.
    this._bZone = make();
    (t.zones || []).forEach((z, i) => file(this._bZone, i, z.y0, z.y1));
    this.zoneUsed = (t.zones || []).map(() => 0);
    // A pulse well's per-marble clock and strength (8 slots per zone).
    this.wellT = new Int32Array((t.zones || []).length * 8);
    this.wellK = new Float64Array((t.zones || []).length * 8);
    this._bCannon = make();
    (t.cannons || []).forEach((c, i) => file(this._bCannon, i, c.y - c.catch, c.y + c.catch));
    this.cannonState = (t.cannons || []).map(() => ({ until: [], last: -1e9, served: 0 }));
    // TIMED WEAR (Sanjay): a hold (cannon fuse, bridge confirmation, vault
    // lock, claw, freeze) is longer for the first marble it takes and a
    // step shorter for each one after, never shorter than it is today.
    // Ticks: extra for the first, less `step` per marble already served.
    const HW = t.wear?.hold;
    this.holdExtra = HW ? Math.round(HW.extra * 240) : 0;
    this.holdStep = HW ? Math.round(HW.step * 240) : 0;
    this.gateWear = t.wear?.gate || null;
    this.regroupState = (t.regroups || []).map(() => ({ first: -1, open: false }));
    this.flips = (t.flippers || []).map(f => ({
      tick: -1, kicked: 0, len: f.len, wear: 0, ax: f.px, ay: f.py,
      bx: f.px + f.rx * f.len, by: f.py + f.ry * f.len,
      vx: 0, vy: 0,                // tip velocity this tick
    }));
    this._nBands = n;
  }

  /** The band a world y falls in, clamped to the index. */
  _band(y) {
    const k = Math.floor((y + BAND) / BAND);
    return k < 0 ? 0 : k >= this._nBands ? this._nBands - 1 : k;
  }

  /** Put the field back on the grid. Call before every race, including the first. */
  reset(rng) {
    this.rng = rng;
    this.time = 0;
    this.gateOpen = false;
    this.nudges = 0;
    this.hits = [];                 // bumper indices struck this tick, for sparks
    this.events = [];               // knockouts this tick, for the page to announce
    this.outCount = 0;
    this.tick = 0;
    this.flips.forEach((s, i) => { s.tick = -1; s.kicked = 0; s.wear = 0; this._flipRest(s, this.track.flippers[i], this.track.flippers[i].len); });
    for (const p of this.pads) { p.tick = -1; p.used = 0; p.gone = false; }
    this.holeUsed.fill(0);
    this._resetElements();

    const g = this.track.grid;

    // DRAW FOR GRID POSITION, from the seed.
    //
    // Without this the racers sit in fixed index order every race, so the same
    // marble always starts on the outside left and the same one on the outside
    // right. Any course that even slightly favours a side then favours the
    // SAME racer for ever: over 300 races Bullion won 28.5% and Blaze 12.8%,
    // a chi-square of 20.0 against 9.49 for p=0.05. In a betting product that
    // is not a quirk, it is a standing edge for anyone who notices it.
    //
    // The draw is part of the seeded race, so it is still reproducible and
    // still published with the result.
    const lanes = this.marbles.map((_, i) => i);
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = Math.floor((rng ? rng() : 0) * (i + 1));
      const t = lanes[i]; lanes[i] = lanes[j]; lanes[j] = t;
    }

    for (const m of this.marbles) {
      const i = lanes[m.index];
      m.lane = i;
      // Seeded jitter, in a FIXED marble order, so the draw is the only thing
      // that moves between races.
      m.x = g.x0 + i * g.dx + (rng ? rng.spread(g.jitter) : 0);
      m.y = g.y0 - (i % 2) * g.stagger;
      m.vx = 0; m.vy = 0; m.spin = 0;
      m.finished = false;
      m.finishTime = 0;
      m.out = false; m.outTime = 0; m.outBy = ''; m.layer = 0;
      m.progress = m.y; m.bestTick = 0;
      m.stuckX = m.x; m.stuckY = m.y;
      m.stuckTime = 0; m.lastNudge = null; m.wellUntil = 0;
    }
    for (const b of this.track.bumpers) b.flash = 0;
  }

  /** Lift the start gate. */
  openGate() { this.gateOpen = true; }

  /**
   * Settle the field onto the gate, for exactly `ticks`.
   *
   * Both the committed run and the on-screen run must do this IDENTICALLY, or
   * they are not the same race. The bug this exists to prevent: the page ran
   * physics all through the betting phase, so by the time a viewer pressed
   * start the marbles had drifted somewhere the committed run never visited,
   * and the race that played out had a different winner from the one the
   * commitment hash covered. The self-check in main2d caught it; without that
   * check it would have looked like a working game that quietly paid out on
   * the wrong marble.
   *
   * Nothing here consumes the rng, `_unstick` is the only consumer and it
   * is gated on `racing`, so the rng is in the same state either way.
   */
  settle(ticks = SETTLE_TICKS) {
    for (let i = 0; i < ticks; i++) this.step(false);
  }

  /** Exact physical state, enough to resume the race bit for bit. */
  snapshot() {
    return this.marbles.map(m => [m.x, m.y, m.vx, m.vy, m.spin]);
  }

  restore(snap) {
    this.marbles.forEach((m, i) => {
      const s = snap[i];
      m.x = s[0]; m.y = s[1]; m.vx = s[2]; m.vy = s[3]; m.spin = s[4];
      m.finished = false; m.finishTime = 0; m.progress = m.y; m.bestTick = 0;
      m.out = false; m.outTime = 0; m.outBy = ''; m.layer = 0;
      m.stuckX = m.x; m.stuckY = m.y; m.stuckTime = 0; m.lastNudge = null; m.wellUntil = 0;
    });
    this.time = 0;
    this.nudges = 0;
    this.outCount = 0;
    this.events.length = 0;
    this.flips.forEach((s, i) => { s.tick = -1; s.kicked = 0; s.wear = 0; this._flipRest(s, this.track.flippers[i], this.track.flippers[i].len); });
    for (const p of this.pads) { p.tick = -1; p.used = 0; p.gone = false; }
    this.holeUsed.fill(0);
    this._resetElements();
    this.tick = 0;
  }

  _resetElements() {
    this.zoneUsed.fill(0);
    this.track.bumpers.forEach((p, i) => { this.pegR[i] = p.r; });
    this.pegHit.fill(0);
    for (const r of this.regroupState) { r.first = -1; r.open = false; }
    for (const c of this.cannonState) { c.until = []; c.last = -1e9; c.served = 0; }
    for (const m of this.marbles) { m.frozen = 0; m.frozenBy = ''; m.held = null; }
  }

  /**
   * Is a timed gate open right now? Driven by the integer race tick, so it is
   * the same in every replay, and drawn from the same numbers, so what a
   * viewer sees is exactly what the physics did.
   */
  timedGateOpen(gt) {
    // Every timed floor, cup and laser stays shut until the start: before it
    // no marble can reach one, and a cup showing open on the grid (the
    // Cascade opener) looked like the course had started without the field.
    if (!this.gateOpen) return false;
    // CONSENSUS: several validator lights on their own beats; the gate is
    // open while at least `need` of them are green.
    if (gt.multi) {
      let n = 0;
      for (const v of gt.multi) if (((this.tick + v.phase) % v.period) < v.open) n++;
      return n >= gt.need;
    }
    // GATE WEAR (Sanjay): a gate's CLOSED spell starts `up` longer than
    // standard and loses `step` of it for each marble already past, down to
    // `min` of standard; the OPEN spell never changes. The first to arrive
    // waits longest; lasers, cups and hatches get easier as the field goes
    // through. (Shrinking the open spell instead left a cup open too briefly
    // to fall through, and no marble ever got past to wear it: deadlock.)
    const W = this.gateWear;
    if (W && gt.wear) {
      let n = 0;
      for (const m of this.marbles) if (m.progress > gt.wy) n++;
      const mult = Math.max(W.min ?? 0.7, 1 + (W.up - W.step * n) * (gt.wk ?? 1));
      const period = gt.open + Math.round((gt.period - gt.open) * mult);
      return ((this.tick + gt.phase) % period) < gt.open;
    }
    return ((this.tick + gt.phase) % gt.period) < gt.open;
  }

  /**
   * How far open a sliding door is, 0 (shut) to 1 (fully open), from the
   * integer race tick. A triangle wave: the door is ALWAYS moving, rising and
   * falling at a steady pace, so what decides a marble's fate is exactly where
   * the door is at the instant it arrives. Plain arithmetic, so it is the same
   * in every replay and the renderer can draw the very same position.
   */
  doorOpen(d) {
    const u = ((this.tick + d.phase) % d.period) / d.period;     // 0..1
    return u < 0.5 ? u * 2 : 2 - u * 2;
  }

  /** Move every sliding door to where it is this tick. */
  _doors() {
    for (const s of this._doorSegs) {
      const d = s.door;
      const top = d.y0 - (d.travel ?? d.len) * this.doorOpen(d);
      s.ay = top; s.by = top + d.len;
    }
  }

  /**
   * Sweeping white and grey holes: where each one is this tick, -1..1 of its
   * sweep. Sanjay's idea. A hole that stands still catches whoever's LINE
   * passes it, and lines are set by speed and lane, so the same kind of run
   * kept getting the bonus (fast marbles were caught a third as often as
   * slow ones). A hole that never stops moving catches whoever arrives when
   * it happens to be there: timing, not line, so it lands on any place in the
   * field. A triangle wave eased at each end, (3t - t^3) / 2, so it glides
   * and turns rather than bouncing. Plain arithmetic from the integer tick.
   */
  swayAt(o) {
    const u = ((this.tick + o.swayPhase) % o.swayPeriod) / o.swayPeriod;
    const t = u < 0.5 ? u * 4 - 1 : 3 - u * 4;
    return (3 * t - t * t * t) / 2;
  }

  _sway() {
    for (const o of this._swayHoles) o.x = o.x0 + o.sway * this.swayAt(o);
  }

  /** Are hazards still live? False once MAX_OUT marbles have been knocked out. */
  get armed() { return this.outCount < MAX_OUT; }

  /**
   * Take a marble out of the race.
   *
   * It is parked off the course rather than deleted, so every array index
   * stays valid and the renderer can still find it to play the exit.
   */
  _eliminate(m, cause, x, y) {
    m.out = true;
    m.outTime = this.time;
    m.outBy = cause;
    m.outX = x; m.outY = y;
    m.vx = 0; m.vy = 0;
    this.outCount++;
    this.events.push({ type: 'out', index: m.index, cause });
  }

  /** Everyone home, or out of it? */
  get allFinished() { return this.marbles.every(m => m.finished || m.out); }

  /**
   * Advance exactly one fixed tick.
   *
   * `racing` gates the clock and the finish line only. Physics runs in every
   * phase, so the field settles on the grid during the countdown and keeps
   * rolling into the basin after the flag.
   */
  step(racing = true) {
    const h = SIM_DT;
    if (racing) { this.time += h; this.tick++; }
    this.hits.length = 0;
    this.events.length = 0;

    const t = this.track;
    const holes = t.holes || [];
    const flippers = t.flippers || [];
    if (flippers.length) this._flipperPoses(racing, h);
    if (this._doorSegs.length) this._doors();
    if (this._swayHoles.length) this._sway();
    const rotors = t.rotors || [], movers = t.movers || [], zones = t.zones || [], cannons = t.cannons || [];
    if (this.regroupState.length) this._regroups();
    if (rotors.length) this._rotorPoses();
    if (movers.length) this._moverPoses();

    for (const m of this.marbles) {
      if (m.out) continue;
      // Frozen in a cryo trap: pinned where it stands, a solid obstacle to
      // the others (see _marbleVsMarble), until the thaw.
      if (m.frozen) {
        if (this.tick < m.frozen) { m.vx = 0; m.vy = 0; continue; }
        m.frozen = 0;
        this.events.push({ type: 'thaw', index: m.index });
      }
      // Loaded in a cannon: sits in the barrel until it fires.
      if (m.held) {
        const c = m.held;
        if (this.tick < c.fire) { m.x = c.x; m.y = c.y; m.vx = 0; m.vy = 0; continue; }
        if (c.teleport) { m.x = c.ox; m.y = c.oy; }
        m.vx = c.vx; m.vy = c.vy; m.held = null;
        m.stuckX = m.x; m.stuckY = m.y; m.stuckTime = 0; m.bestTick = this.tick;
        this.events.push({ type: 'fire', index: m.index });
      }
      m.vy += GRAVITY * h;
      if (zones.length && racing) this._zones(m, zones, h);

      // Black holes pull BEFORE integration, as a force alongside gravity.
      if (holes.length) this._pull(m, holes, h);

      // Linear drag, not exp(). Exact arithmetic, identical on every engine.
      const drag = 1 - AIR_DRAG * h;
      m.vx *= drag;
      m.vy *= drag;

      const sp2 = m.vx * m.vx + m.vy * m.vy;
      if (sp2 > MAX_SPEED * MAX_SPEED) {
        const k = MAX_SPEED / Math.sqrt(sp2);
        m.vx *= k; m.vy *= k;
      }

      m.x += m.vx * h;
      m.y += m.vy * h;

      if (!this.gateOpen) this._segment(m, t.gate, REST_GATE, MU_WALL);

      const k = this._band(m.y);
      const segs = this._bSeg[k];
      for (let j = 0; j < segs.length; j++) {
        const s = t.segments[segs[j]];
        // LAYERS. A loop-the-loop has to cross its own path, which a flat 2D
        // world cannot do, so a few walls belong to one layer only and a
        // marble switches layer as it goes over the top (see _sensors).
        // Walls with no layer are solid to everyone, which is all of them
        // outside a loop.
        if (s.layer !== undefined && s.layer !== m.layer) continue;
        // A safety net: solid only once hazards have disarmed.
        if (s.safe && this.armed) continue;
        // A timed gate: not there while it is open. (Doors, which slide, are
        // ordinary segments moved into place each tick: see _doors.)
        if (s.gate && this.timedGateOpen(s.gate)) continue;
        if (s.regroup !== undefined && this.regroupState[s.regroup].open) continue;
        if (s.belt) { this._belt(m, s); continue; }
        if (this._segment(m, s, s.rest ?? REST_WALL, MU_WALL) && s.boost) {
          // A dash pad: whatever the marble was doing, it now leaves at the
          // pad's speed. It re-fires every time, which is what rescues a
          // marble that failed the loop and rolled back: it is simply
          // launched again, so a loop can never be a trap.
          const b = s.boost;
          if (b.pulse) {
            // A PUMP: its strength swings between lo and hi on its own beat,
            // so how hard a marble is launched depends on WHEN it arrives.
            const v = this.pumpSpeed(b);
            m.vx = b.ux * v; m.vy = b.uy * v;
          } else { m.vx = b.vx; m.vy = b.vy; }
        }
      }
      if (rotors.length) {
        const rk = this._bRotor[k];
        for (let j = 0; j < rk.length; j++) this._rotor(m, rotors[rk[j]]);
      }
      if (movers.length) {
        const mk = this._bMover[k];
        for (let j = 0; j < mk.length; j++) this._mover(m, movers[mk[j]]);
      }
      if (cannons.length && racing) {
        const ck = this._bCannon[k];
        for (let j = 0; j < ck.length; j++) if (this._cannon(m, cannons[ck[j]], ck[j])) break;
        if (m.held) continue;
      }
      const bowls = this._bBowl[k];
      for (let j = 0; j < bowls.length; j++) this._bowl(m, t.bowls[bowls[j]]);
      const caps = this._bCap[k];
      for (let j = 0; j < caps.length; j++) this._capsule(m, t.capsules[caps[j]]);
      if (this.pads.length) {
        const sk = this._bSpring[k];
        for (let j = 0; j < sk.length; j++) this._spring(m, t.springs[sk[j]], this.pads[sk[j]], racing);
      }
      if (flippers.length) {
        const fk = this._bFlip[k];
        for (let j = 0; j < fk.length; j++) this._flipper(m, flippers[fk[j]], this.flips[fk[j]]);
      }

      const pegs = this._bPeg[k];
      for (let j = 0; j < pegs.length; j++) {
        const i = pegs[j];
        const b = t.bumpers[i];
        const dx = m.x - b.x, dy = m.y - b.y;
        const rr = m.r + this.pegR[i];
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 <= 1e-9) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d;
        m.x = b.x + nx * rr;
        m.y = b.y + ny * rr;
        // Per-obstacle bounce. A steel pin and a wooden dome are both circles
        // to the solver but they are not the same obstacle: the pin is the
        // arcade reshuffler and wants to throw a marble, the dome is scenery
        // the field flows around. Defaults keep every existing peg identical.
        // A whale core is never a perch: a marble the pulse left sitting on
        // its crown (0.3% of Whale Gravity appearances) tips off the side it
        // leans to, like the bare end of a wall.
        if (b.whale && ny < -0.985 && m.vx < 40 && m.vx > -40) m.vx += (m.x > b.x ? 1 : m.x < b.x ? -1 : (m.index & 1 ? 1 : -1)) * 8;
        if (resolve(m, nx, ny, b.rest ?? REST_BUMPER, b.mu ?? MU_BUMPER)) {
          if (b.flashes !== false) { b.flash = 1; this.hits.push(i); }
          if (b.wear && racing && !(this.pegHit[i] & (1 << m.index))) {
            this.pegHit[i] |= 1 << m.index;
            this.pegR[i] = Math.max(b.min, this.pegR[i] - b.wear);
          }
        }
      }

      if (holes.length) {
        const hk = this._bHole[k];
        for (let j = 0; j < hk.length; j++) {
          if (this._swallow(m, holes[hk[j]], hk[j])) break;
        }
        if (m.out) continue;
      }

      if (t.sensors && t.sensors.length) this._sensors(m, t.sensors);

      // Pits: a marble whose centre drops into one while hazards are live is
      // out. Only during the race, so settling can never knock anyone out.
      if (racing && this.armed && t.pits && t.pits.length && this.time > 0) {
        for (let i = 0; i < t.pits.length; i++) {
          const p = t.pits[i];
          if (m.x > p.x0 && m.x < p.x1 && m.y > p.y0 && m.y < p.y1) {
            this._eliminate(m, p.name, m.x, m.y);
            break;
          }
        }
        if (m.out) continue;
      }

      if (racing && !m.finished && m.y > t.finishY) {
        m.finished = true;
        m.finishTime = this.time;
      }
      if (m.y > m.progress) { m.progress = m.y; m.bestTick = this.tick; }
    }

    this._marbleVsMarble();
    this._rescue();
    if (racing) this._unstick(h);

    for (const b of this.track.bumpers) {
      if (b.flash > 0) b.flash = Math.max(0, b.flash - h * 4);
    }
    // A fired pad keeps counting (for its vanishing animation) but never
    // re-arms: it is gone for the rest of the race.
    for (const p of this.pads) if (p.tick >= 0 && p.tick < 10000) p.tick++;
  }

  /** Layer switches: a marble whose centre is inside the box takes its layer. */
  _sensors(m, S) {
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (m.x > s.x0 && m.x < s.x1 && m.y > s.y0 && m.y < s.y1) m.layer = s.layer;
    }
  }

  /* ------------------------------ hazards ------------------------------ */

  /**
   * A black hole's pull: an attraction that falls off with distance and is
   * tapered to exactly zero at the edge of its reach.
   *
   * Softened inverse square, k / (d^2 + s), times (1 - d^2/P^2). The softening
   * keeps it finite at the centre; the taper is what stops a marble feeling a
   * sudden step in force as it crosses the boundary, which would read on screen
   * as an invisible wall. Only +, *, / and sqrt, all exactly specified, so the
   * pull is identical in every JavaScript engine.
   *
   * Pull, rather than a plain trapdoor, is the point: most marbles are NOT
   * eaten, they are slung. A marble that passes on the near side is whipped
   * round and thrown across the course, one on the far side barely bends, and
   * which of those happens depends on a few pixels of line. That is the
   * uncertainty the hazard is for; the knockout is the rare outcome of it.
   */
  _pull(m, holes, h) {
    const hk = this._bHole[this._band(m.y)];
    for (let j = 0; j < hk.length; j++) {
      const o = holes[hk[j]];
      // A black hole stops pulling once hazards disarm. A white or grey hole
      // ignores a marble it has already warped.
      if (o.kind === 'black' ? !this.armed : (this.holeUsed[hk[j]] & (1 << m.index))) continue;
      const dx = o.x - m.x, dy = o.y - m.y;
      const d2 = dx * dx + dy * dy;
      const P2 = o.pull * o.pull;
      if (d2 >= P2 || d2 <= 1e-9) continue;
      const d = Math.sqrt(d2);
      const a = (o.k / (d2 + o.soft)) * (1 - d2 / P2);
      m.vx += (dx / d) * a * h;
      m.vy += (dy / d) * a * h;
    }
  }

  /**
   * Inside the event horizon, a live hole takes the marble. A hole that has
   * gone dormant (the knockout cap was reached) is only a solid dome.
   * Returns true when the marble was taken.
   */
  _swallow(m, o, i) {
    const dx = m.x - o.x, dy = m.y - o.y;
    const d2 = dx * dx + dy * dy;
    if (o.kind !== 'black') return this._warp(m, o, i, d2);
    if (this.armed) {
      if (d2 < o.eat * o.eat && this.time > 0) {
        this._eliminate(m, o.name || 'Black hole', o.x, o.y);
        return true;
      }
      return false;
    }
    const rr = m.r + o.core;
    if (d2 >= rr * rr || d2 <= 1e-9) return false;
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d;
    m.x = o.x + nx * rr;
    m.y = o.y + ny * rr;
    resolve(m, nx, ny, 0.25, MU_BOWL);
    return false;
  }

  /**
   * Fire any idle flipper that a marble is resting on, then set every
   * flipper's pose and angular velocity for this tick.
   *
   * Triggered by CONTACT, like the real thing, rather than on a clock: a timer
   * flipper kicks empty air most of the time and reads as decoration. Only
   * during the race, so settling on the grid can never change its state.
   */
  _flipperPoses(racing, h) {
    const F = this.track.flippers;
    for (let i = 0; i < F.length; i++) {
      const f = F[i], s = this.flips[i];
      // ONE THROW PER MARBLE PER FLIPPER. Without it the course can loop: a
      // thrown marble lands back on the ramp that fed it, rolls down onto the
      // same flipper and is thrown again, for ever. Measured: 138 of 200
      // races never finished, one marble on its eighth throw at 20 seconds,
      // and not one stall nudge, because a marble that keeps flying is never
      // "stuck". Any flipper under gravity can do this whatever the geometry,
      // so it needs a guarantee rather than a tuning: a flipper fires only for
      // a marble it has not thrown yet, which bounds it to five throws a race.
      if (racing && s.tick < 0) {
        const reach = (MARBLE_R + f.fr + 2) ** 2;
        let fire = 0;
        for (const m of this.marbles) {
          if (m.out || m.finished || (s.kicked & (1 << m.index))) continue;
          if (distSeg2(m.x, m.y, s.ax, s.ay, s.bx, s.by) < reach) fire |= 1 << m.index;
        }
        if (fire) {
          s.tick = 0; s.kicked |= fire;
          if (f.wear) for (let b = fire; b; b &= b - 1) s.wear++;
        }
      }
      // A worn flipper gets shorter only while it is at rest, and the pose
      // is moved with it, so the change is never read as tip speed:
      // shortening mid-stroke would be a kick from nowhere. It shrinks
      // SMOOTHLY, half a unit a tick (40 in a third of a second): all at
      // once, it jumped a step shorter in one frame and looked like a bug
      // (Sanjay). Halves are exact in binary, so every engine agrees.
      if (s.tick < 0 && f.wear) {
        const want = Math.max(f.min, f.len - f.wear * s.wear);
        if (want < s.len) this._flipRest(s, f, s.len - FLIP_SHRINK > want ? s.len - FLIP_SHRINK : want);
      }
      // Stroke position 0 (rest) .. 1 (up), from the integer tick count.
      const k = s.tick;
      let p = 0;
      if (k >= 0 && k < FLIP_UP) p = k / FLIP_UP;
      else if (k >= FLIP_UP && k < FLIP_UP + FLIP_HOLD) p = 1;
      else if (k >= FLIP_UP + FLIP_HOLD && k < FLIP_UP + FLIP_HOLD + FLIP_DOWN) {
        p = 1 - (k - FLIP_UP - FLIP_HOLD) / FLIP_DOWN;
      }
      // NO cos/sin. Blend the two unit directions and renormalise: a rotation
      // built from + - * / and sqrt only, which IEEE 754 fixes to the last bit
      // on every engine. The trig functions are not so fixed, and a flipper
      // is a chaotic element: a last-bit difference between the server and a
      // viewer's browser would grow into a different race on screen.
      let dx = f.rx + (f.ux - f.rx) * p, dy = f.ry + (f.uy - f.ry) * p;
      const l = Math.sqrt(dx * dx + dy * dy);
      dx /= l; dy /= l;
      const bx = f.px + dx * s.len, by = f.py + dy * s.len;
      s.vx = (bx - s.bx) / h;
      s.vy = (by - s.by) / h;
      s.bx = bx; s.by = by;
      if (k >= 0) s.tick = k + 1 >= FLIP_END ? -1 : k + 1;
    }
  }

  /** Put a flipper at rest at length `len`, with no tip speed. */
  _flipRest(s, f, len) {
    s.len = len;
    s.bx = f.px + f.rx * len; s.by = f.py + f.ry * len;
    s.vx = 0; s.vy = 0;
  }

  /**
   * A spring pad: a trampoline.
   *
   * It is a wall first, always, so a pad can never be a hole in the course,
   * and only its upper face fires. When it is charged and this marble has not
   * been launched by it yet, the marble's speed INTO the pad becomes a launch
   * OUT of it along the normal, of base + gain x impact speed. So a hard
   * landing throws high and a soft one pops; what the marble was doing along
   * the pad is kept, so a glancing arrival flies long. Every launch differs,
   * and always for a reason a viewer can see: deliberately NOT a random power
   * per press, which would make two identical-looking landings behave
   * differently, and in a betting product that reads as rigged.
   *
   * Same one-launch-per-marble rule as the flippers, for the same reason.
   */
  _spring(m, p, st, racing) {
    // ONE SHOT, Sanjay's call: a pad fires for the first marble that lands on
    // it and is then gone, so everyone behind drops straight through the
    // space. A pad that stays solid after firing let one marble bounce from
    // pad to pad all the way down; this way each pad is one event, for one
    // marble, and who gets it is decided by who arrives first.
    if (st.gone) return;
    const dx = p.bx - p.ax, dy = p.by - p.ay;
    let u = ((m.x - p.ax) * dx + (m.y - p.ay) * dy) / (dx * dx + dy * dy);
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = p.ax + u * dx, py = p.ay + u * dy;
    let nx = m.x - px, ny = m.y - py;
    const d2 = nx * nx + ny * ny;
    if (d2 >= m.r * m.r || d2 <= 1e-9) return;
    const d = Math.sqrt(d2);
    nx /= d; ny /= d;
    m.x = px + nx * m.r;
    m.y = py + ny * m.r;

    const bit = 1 << m.index;
    // Only from the pad's working face, and only when charged.
    const face = nx * p.nx + ny * p.ny > 0.5;
    if (racing && face && st.tick < 0 && !(st.used & bit)) {
      const vn = m.vx * p.nx + m.vy * p.ny;          // negative: arriving
      const out = p.base - p.gain * vn;
      m.vx += p.nx * (out - vn);
      m.vy += p.ny * (out - vn);
      st.tick = 0;
      st.used |= bit;
      st.gone = true;
      return;
    }
    resolve(m, nx, ny, REST_WALL, MU_WALL);
  }

  /**
   * A flipper is a capsule that MOVES. The contact is solved in the flipper's
   * frame: take off the surface velocity at the contact point, resolve as a
   * stationary wall, put it back. That transfer of the surface's own speed is
   * the kick. Solving it as a fixed wall that happens to be in a new place
   * each tick would only ever push marbles out of the way, never throw them.
   */
  _flipper(m, f, s) {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy;
    let u = ((m.x - s.ax) * dx + (m.y - s.ay) * dy) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = s.ax + u * dx, py = s.ay + u * dy;
    let nx = m.x - px, ny = m.y - py;
    const rr = m.r + f.fr;
    const d2 = nx * nx + ny * ny;
    if (d2 >= rr * rr || d2 <= 1e-9) return;
    const d = Math.sqrt(d2);
    nx /= d; ny /= d;
    m.x = px + nx * rr;
    m.y = py + ny * rr;
    // Surface velocity at the contact. The pivot is still and the tip moves at
    // (s.vx, s.vy), so a rigid rotation gives u times the tip's velocity.
    // THROW vs SIZE (Sanjay: the first, biggest flipper throws hardest and
    // each throw after is smaller, but never hard enough to send a marble
    // sections back). Every flipper turns through the same angle in the same
    // time, so the surface speed at a contact is (spin x distance from the
    // hinge), and an unscaled 310 flipper's tip moved 1.8x a standard one's:
    // that threw marbles two stages back. Scale the whole arm so its TIP
    // speed is `boost` x standard at full size, falling smoothly to exactly
    // standard at the smallest, in a straight line (+ - * / only: a
    // fractional power is not guaranteed bit-identical on every engine).
    let k = 1;
    if (s.len > f.min) k = (1 + (f.boost - 1) * (s.len - f.min) / (f.len - f.min)) * f.min / s.len;
    const vsx = s.vx * u * k, vsy = s.vy * u * k;
    m.vx -= vsx; m.vy -= vsy;
    resolve(m, nx, ny, REST_FLIP, MU_WALL);
    m.vx += vsx; m.vy += vsy;
  }

  /**
   * Which way a grey hole is pointing right now: +1 forward, -1 back.
   *
   * A VISIBLE cycle on the race clock, not a coin flip at the moment of
   * capture. The renderer draws the same phase, so anyone watching can see
   * which way it was pointing when their marble went in. A hidden flip would
   * make two identical-looking entries come out opposite ways, which in a
   * betting product reads as rigged however fair it is.
   */
  holeDir(o) {
    if (o.kind === 'white') return 1;
    return Math.floor((this.tick + o.phase) / o.half) % 2 === 0 ? 1 : -1;
  }

  /**
   * White and grey holes: inside the horizon, the marble is moved to the
   * hole's destination, a few sections ahead or behind, and dropped in.
   * Returns true when it warped.
   */
  _warp(m, o, i, d2) {
    const bit = 1 << m.index;
    if ((this.holeUsed[i] & bit) || d2 >= o.eat * o.eat || this.time <= 0) return false;
    const dir = this.holeDir(o);
    const to = dir > 0 ? o.ahead : o.behind;
    this.holeUsed[i] |= bit;
    const fromX = m.x, fromY = m.y;
    m.x = to.x; m.y = to.y;
    // Never dropped dead straight: a marble falling with no sideways speed
    // onto a peg's crown or the rim between two cups balanced there until
    // the loiter rescue, 8s later. It was a third of all nudges on full
    // courses (600 races), every one at the drop point's x.
    m.vx = ((this.tick + m.index) & 1 ? 1 : -1) * 60; m.vy = 120;
    // Progress only ever rises, for a steady standings board; a marble sent
    // BACK has genuinely lost ground and the board must say so.
    if (dir < 0) { m.progress = m.y; m.bestTick = this.tick; }
    m.stuckX = m.x; m.stuckY = m.y; m.stuckTime = 0;
    this.events.push({ type: 'warp', index: m.index, dir, kind: o.kind,
                       fromX, fromY, toX: m.x, toY: m.y, secs: to.secs });
    return true;
  }

  /* ---------------------------- collisions ---------------------------- */

  /** Circle vs line segment, by closest point. No corners, anywhere. */
  _segment(m, s, rest, mu) {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy;
    let u = len2 > 1e-9 ? ((m.x - s.ax) * dx + (m.y - s.ay) * dy) / len2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;

    const px = s.ax + u * dx, py = s.ay + u * dy;
    let nx = m.x - px, ny = m.y - py;
    const d2 = nx * nx + ny * ny;
    if (d2 >= m.r * m.r || d2 <= 1e-9) return false;

    const d = Math.sqrt(d2);
    nx /= d; ny /= d;
    m.x = px + nx * m.r;
    m.y = py + ny * m.r;
    resolve(m, nx, ny, rest, mu);
    // NO BALANCING ON A POINT. Resting on the bare END of a wall with the
    // contact straight up is an equilibrium only a simulation can hold: a
    // real marble wobbles off (the Bridge cup's tip held marbles until the
    // rescue, 4 races in 800). Tip it the way gravity would take it: on the
    // HIGH end of a slope, onto the slope, so it rolls down; on a low or
    // level end, off the end. First version always tipped off the end, and
    // on the Halving that pushed marbles off a ramp's high end into the
    // divider beside it: 76 stuck. A vertical wall's top has no downhill,
    // so each marble has its own fixed side (never alternating per tick,
    // which just rocks it in place).
    if ((u === 0 || u === 1) && ny < -0.985 && m.vx < 40 && m.vx > -40) {
      const ox = u === 0 ? s.bx : s.ax, oy = u === 0 ? s.by : s.ay;
      let dir = px > ox ? 1 : px < ox ? -1 : (m.index & 1 ? 1 : -1);
      if (py < oy - 1 && px !== ox) dir = -dir;          // the high end: onto the slope
      m.vx += dir * 8;
    }
    return true;
  }

  /**
   * A capsule: a segment with thickness. Convex, smooth, and TILTABLE.
   *
   * This exists because a circle has a flat spot. A marble resting on the apex
   * of a circle sits in an exact equilibrium, gravity is along the contact
   * normal, so there is no tangential force at all, and it never topples.
   * The bowl islands were the worst offenders because they are the largest
   * circles on the course.
   *
   * A capsule tilted off vertical fixes it two ways. Its long flanks are
   * inclined, so anything landing on them slides off at once; and the only
   * true balance point left is the crown of the upper end cap, which is small
   * and tightly curved, so the slightest displacement rolls a marble away.
   * The union of two equal-radius circles along a line has no cusp, unlike two
   * overlapping circles of different sizes.
   */
  _capsule(m, c) {
    const dx = c.bx - c.ax, dy = c.by - c.ay;
    const len2 = dx * dx + dy * dy;
    let u = len2 > 1e-9 ? ((m.x - c.ax) * dx + (m.y - c.ay) * dy) / len2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;

    const px = c.ax + u * dx, py = c.ay + u * dy;
    let nx = m.x - px, ny = m.y - py;
    const rr = m.r + c.r;
    const d2 = nx * nx + ny * ny;
    if (d2 >= rr * rr || d2 <= 1e-9) return;

    const d = Math.sqrt(d2);
    nx /= d; ny /= d;
    m.x = px + nx * rr;
    m.y = py + ny * rr;
    resolve(m, nx, ny, c.rest ?? REST_BOWL, c.mu ?? MU_BOWL);
  }

  /**
   * The bowl: a ring wall the marble is trapped inside, with angular gaps.
   *
   * Contact only from the inside, so a marble entering through the top gap is
   * caught, circles losing speed to friction, and leaves through the drain.
   * This is the only element in either reference that truly reshuffles the
   * order, whoever finds the drain first wins the exchange regardless of who
   * arrived first. Everything else merely spreads the field out.
   */
  _bowl(m, b) {
    const dx = m.x - b.x, dy = m.y - b.y;
    const d2 = dx * dx + dy * dy;
    const outer = b.R + 80;
    if (d2 <= 1e-9 || d2 > outer * outer) return;

    const d = Math.sqrt(d2);
    if (d + m.r <= b.R) return;                 // comfortably inside

    // In a gap when the marble's direction from the centre is within `half`
    // of the gap's own direction: a dot product against cos(half). This was
    // atan2 per marble per tick, a transcendental whose last bit is NOT fixed
    // across JavaScript engines, in the one element whose whole job is to be
    // chaotic. A last-bit difference there could grow into a different winner
    // on a viewer's screen from the one the server committed.
    const ux = dx / d, uy = dy / d;
    for (let i = 0; i < b.gaps.length; i++) {
      const gp = b.gaps[i];
      if (ux * gp.cx + uy * gp.cy > gp.cosHalf) return;
    }

    const target = b.R - m.r;
    m.x = b.x + (dx / d) * target;
    m.y = b.y + (dy / d) * target;
    resolve(m, -dx / d, -dy / d, REST_BOWL, MU_BOWL);
  }

  _marbleVsMarble() {
    const M = this.marbles;
    for (let i = 0; i < M.length; i++) {
      for (let j = i + 1; j < M.length; j++) {
        const a = M[i], b = M[j];
        if (a.out || b.out) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const rr = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 <= 1e-9) continue;

        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d;
        // A frozen or loaded marble is pinned: the other takes the whole
        // push and the whole bounce, as off a wall.
        const pa = a.frozen || a.held, pb = b.frozen || b.held;
        if (pa && pb) continue;
        const wa = pa ? 0 : pb ? 1 : 0.5, wb = 1 - wa;
        a.x -= nx * (rr - d) * wa; a.y -= ny * (rr - d) * wa;
        b.x += nx * (rr - d) * wb; b.y += ny * (rr - d) * wb;

        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn >= 0) continue;
        const imp = -(1 + REST_MARBLE) * vn;
        a.vx -= imp * wa * nx; a.vy -= imp * wa * ny;
        b.vx += imp * wb * nx; b.vy += imp * wb * ny;
      }
    }
  }

  /* ---------------------------- keeping it honest --------------------- */

  /**
   * Anything that has left the course entirely goes back on it.
   *
   * Cheap insurance. A 2D world bounded by two side walls is much harder to
   * escape than a 3D deck, but a marble squeezed hard into a corner by four
   * others can still be pushed through a wall, and one lost marble means a
   * race that never ends and a pool that cannot be settled.
   */
  _rescue() {
    const t = this.track;
    // Openings in a side wall (The Edge) are the one place a marble is ALLOWED
    // off the course, and only while hazards are live: the pit box outside
    // the wall then takes it. Once disarmed a barrier closes the opening and
    // the usual clamp applies again.
    const open = this.armed && t.openings && t.openings.length ? t.openings : null;
    for (const m of this.marbles) {
      if (m.out) continue;
      let openL = false, openR = false;
      if (open) {
        for (const o of open) {
          if (m.y > o.y0 && m.y < o.y1) { if (o.side < 0) openL = true; else openR = true; }
        }
      }
      const lo = t.wallL + m.r, hi = t.wallR - m.r;
      if (!openL && m.x < lo) { m.x = lo; if (m.vx < 0) m.vx = -m.vx * 0.3; }
      if (!openR && m.x > hi) { m.x = hi; if (m.vx > 0) m.vx = -m.vx * 0.3; }
      if (m.y < -200) { m.y = -200; if (m.vy < 0) m.vy = 0; }
      if (m.y > t.basinY + 400) { m.y = t.basinY; m.vy = 0; }
    }
  }

  /* ------------------------- moving elements ------------------------- */

  /**
   * THE SAFETY CAR (experimental, not in the random pool). A floor that stays
   * shut until every marble still racing has arrived on it, or `timeout`
   * ticks after the first did, then opens and stays open. It erases every gap
   * at that point of the course, whoever is leading: a rule the same for all.
   */
  _regroups() {
    const R = this.track.regroups;
    for (let i = 0; i < R.length; i++) {
      const g = R[i], st = this.regroupState[i];
      if (st.open) continue;
      let waiting = 0, behind = 0;
      for (const m of this.marbles) {
        if (m.out || m.finished || m.y > g.y1) continue;
        if (m.x >= g.x0 && m.x <= g.x1 && m.y >= g.y0) waiting++;
        else behind++;
      }
      if (waiting && st.first < 0) st.first = this.tick;
      // `need`: open once that many are waiting (a SOFT safety car that
      // bunches the front of the field but leaves stragglers be).
      if (st.first >= 0 && (behind === 0 || (g.need && waiting >= g.need) || this.tick - st.first >= g.timeout)) {
        st.open = true;
        this.events.push({ type: 'regroup', index: -1 });
      }
    }
  }

  /** Every windmill's angle this tick. Plain arithmetic from the tick. */
  _rotorPoses() {
    for (const o of this.track.rotors) o.angle = o.phase + o.w * this.tick;
  }

  /** Every moving bumper's position and velocity this tick. */
  _moverPoses() {
    for (const o of this.track.movers) {
      const s0 = (1 + glide(this.tick, o.period, o.phase)) / 2;
      const s1 = (1 + glide(this.tick + 1, o.period, o.phase)) / 2;
      o.x = o.ax + (o.bx - o.ax) * s0; o.y = o.ay + (o.by - o.ay) * s0;
      o.vx = (o.bx - o.ax) * (s1 - s0) * 240; o.vy = (o.by - o.ay) * (s1 - s0) * 240;
    }
  }

  /**
   * A windmill: `arms` straight arms of length `len` and half-thickness `fr`
   * turning about (cx, cy) at `w` radians per tick. Collides like a flipper:
   * against the moving surface, so an arm coming round SWEEPS a marble.
   */
  _rotor(m, o) {
    const dxc = m.x - o.cx, dyc = m.y - o.cy;
    const reach = o.len + o.fr + m.r;
    if (dxc * dxc + dyc * dyc >= reach * reach) return;
    const step = TAU / o.arms, W = o.w * 240;
    for (let a = 0; a < o.arms; a++) {
      const ang = o.angle + a * step;
      const ux = dcos(ang), uy = dsin(ang);
      let u = dxc * ux + dyc * uy;
      u = u < 0 ? 0 : u > o.len ? o.len : u;
      const px = o.cx + ux * u, py = o.cy + uy * u;
      let nx = m.x - px, ny = m.y - py;
      const rr = m.r + o.fr, d2 = nx * nx + ny * ny;
      if (d2 >= rr * rr || d2 <= 1e-9) continue;
      const d = Math.sqrt(d2);
      nx /= d; ny /= d;
      m.x = px + nx * rr; m.y = py + ny * rr;
      // Surface velocity of a rigid rotation: W x (p - c).
      const vsx = -W * (py - o.cy), vsy = W * (px - o.cx);
      m.vx -= vsx; m.vy -= vsy;
      resolve(m, nx, ny, o.rest ?? 0.35, MU_WALL);
      m.vx += vsx; m.vy += vsy;
    }
  }

  /** A moving bumper: a peg that travels a path, and pushes. */
  _mover(m, o) {
    const dx = m.x - o.x, dy = m.y - o.y, rr = m.r + o.r, d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 <= 1e-9) return;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    m.x = o.x + nx * rr; m.y = o.y + ny * rr;
    m.vx -= o.vx; m.vy -= o.vy;
    resolve(m, nx, ny, o.rest ?? 0.7, MU_BUMPER);
    m.vx += o.vx; m.vy += o.vy;
  }

  /**
   * A conveyor: a wall whose surface moves along a->b at `belt` units/s, with
   * grip. Resolved against the moving surface, so a belt running with the
   * slope throws a marble on and one running against it holds it back.
   */
  _belt(m, s) {
    const dx = s.bx - s.ax, dy = s.by - s.ay, L = Math.sqrt(dx * dx + dy * dy);
    const v = this.beltSpeed(s);
    const vsx = dx / L * v, vsy = dy / L * v;
    m.vx -= vsx; m.vy -= vsy;
    this._segment(m, s, REST_WALL, s.mu ?? 0.5);
    m.vx += vsx; m.vy += vsy;
  }

  /**
   * A belt's speed this tick. A REVERSING belt (Sanjay's idea) runs one way
   * for `half` ticks, then the other, from its own phase; which way it is
   * going when a marble lands is timing.
   */
  beltSpeed(s) {
    if (!s.flip) return s.belt;
    return Math.floor((this.tick + s.flip.phase) / s.flip.half) % 2 === 0 ? s.belt : -s.belt;
  }

  /** A pump's launch speed this tick. */
  pumpSpeed(b) {
    const p = b.pulse;
    return p.lo + (p.hi - p.lo) * (1 + glide(this.tick, p.period, p.phase)) / 2;
  }

  /** Is a zone switched on this tick? No cycle means always. */
  /** +1 or -1: which way a swinging wind is blowing now (always +1 otherwise). */
  fanDir(z) {
    return !z.swing || Math.floor((this.tick + z.swing.phase) / z.swing.half) % 2 === 0 ? 1 : -1;
  }

  zoneOn(z) {
    return !z.cycle || ((this.tick + z.cycle.phase) % z.cycle.period) < z.cycle.on;
  }

  /**
   * Zones act on a marble whose CENTRE is inside the box.
   *
   *   fan    a steady push while on (sideways: wind; upwards: an updraft)
   *   cryo   while on, freezes a marble for FREEZE_TICKS, once per marble
   *   brake  a speed camera: a marble over `vmax` is cut to `keep` of it,
   *          once per marble. Slow marbles pass untouched.
   *
   * None of them knows or cares where a marble is in the race: a fan blows
   * on whoever is in it, a trap is on or off by the clock, and a camera
   * reads speed. Sanjay's call: catch-up comes from physics, never from
   * targeting the leader.
   */
  _zones(m, zones, h) {
    const zk = this._bZone[this._band(m.y)];
    for (let j = 0; j < zk.length; j++) {
      const i = zk[j], z = zones[i];
      if (m.x < z.x0 || m.x > z.x1 || m.y < z.y0 || m.y > z.y1) continue;
      if (z.kind === 'fan') {
        if (this.zoneOn(z)) { const d = this.fanDir(z); m.vx += z.fx * d * h; m.vy += z.fy * h; }
        continue;
      }
      if (z.kind === 'well') {
        // A gravity well: pulls toward (cx, cy) with 1/r^2, inside its
        // radius only, softened near the core (a bumper sits there) so the
        // pull never runs away. Bends a line; never captures.
        const dx = z.cx - m.x, dy = z.cy - m.y, d2 = dx * dx + dy * dy;
        if (d2 < z.rad * z.rad) {
          let k = 1;
          if (z.pulse) {
            // A PULSE well (Sanjay): each marble's pull follows a curve from
            // the moment it enters: builds over `rise`, holds, fades to
            // nothing by `end`, so no orbit outlasts it. The first marble in
            // gets the full pull, each later one `step` less, down to
            // `floor`: the leader is held and slung, the field closes up.
            const P = z.pulse, bit = 1 << m.index, slot = i * 8 + m.index;
            if (!(this.zoneUsed[i] & bit)) {
              this.wellK[slot] = Math.max(P.floor, 1 - P.step * this._served(this.zoneUsed[i]));
              this.wellT[slot] = this.tick;
              this.zoneUsed[i] |= bit;
            }
            const a = this.tick - this.wellT[slot];
            if (a >= P.end) continue;
            m.wellUntil = this.wellT[slot] + P.end;   // in its grip: not stuck
            k = this.wellK[slot] * (a < P.rise ? a / P.rise : a < P.hold ? 1 : (P.end - a) / (P.end - P.hold));
          }
          const d = Math.sqrt(d2), s2 = d2 > z.soft * z.soft ? d2 : z.soft * z.soft;
          const a = k * z.pull / s2;
          m.vx += a * dx / d * h; m.vy += a * dy / d * h;
        }
        continue;
      }
      const bit = 1 << m.index;
      if (this.zoneUsed[i] & bit) continue;
      if (z.kind === 'cryo') {
        if (!this.zoneOn(z)) continue;
        const ft = FREEZE_TICKS + this._wornExtra(this._served(this.zoneUsed[i]), z.wk);
        this.zoneUsed[i] |= bit;
        m.frozen = this.tick + ft; m.frozenBy = 'cryo'; m.frozenFor = ft;
        m.vx = 0; m.vy = 0;
        this.events.push({ type: 'freeze', index: m.index, x: m.x, y: m.y, secs: +(ft / 240).toFixed(1) });
      } else if (z.kind === 'grab') {
        // A claw: holds a marble a length of time set by the moment it
        // grabbed (diamond hands long, paper hands short). Once per marble.
        if (z.cycle && !this.zoneOn(z)) continue;
        const hold = Math.round(z.lo + (z.hi - z.lo) * tickNoise(this.tick, i + 1)) + this._wornExtra(this._served(this.zoneUsed[i]), z.wk);
        this.zoneUsed[i] |= bit;
        m.frozen = this.tick + hold; m.frozenBy = 'grab'; m.frozenFor = hold;
        m.x = (z.x0 + z.x1) / 2; m.vx = 0; m.vy = 0;
        this.events.push({ type: 'grab', index: m.index, secs: +(hold / 240).toFixed(1), diamond: z.diamond });
      } else if (z.kind === 'reorg') {
        // A chain reorg: while lit, sends a marble back up to (tx, ty),
        // a block or so behind. Once per marble.
        if (!this.zoneOn(z)) continue;
        this.zoneUsed[i] |= bit;
        // Rewinds position and HALF the momentum: restarted from rest a marble
        // lost anything from 0.2s to 2.8s; carrying (some of) its speed makes
        // the loss mostly the distance sent back, near the same for everyone.
        const fx = m.x, fy = m.y;
        m.x = z.tx; m.y = z.ty; m.vx *= z.keep ?? 0.5; m.vy *= z.keep ?? 0.5;
        m.stuckX = m.x; m.stuckY = m.y; m.stuckTime = 0; m.bestTick = this.tick;
        this.events.push({ type: 'reorg', index: m.index, fromX: fx, fromY: fy, toX: m.x, toY: m.y });
      } else if (z.kind === 'brake') {
        const v2 = m.vx * m.vx + m.vy * m.vy;
        if (v2 <= z.vmax * z.vmax) continue;
        this.zoneUsed[i] |= bit;
        const k = (z.vmax * z.keep) / Math.sqrt(v2);
        m.vx *= k; m.vy *= k;
        this.events.push({ type: 'brake', index: m.index, x: m.x, y: m.y });
      }
    }
  }

  /**
   * A cannon: a marble that reaches the breech is loaded, waits `delay`
   * ticks, and is fired from the muzzle at (vx, vy). Once per marble per
   * cannon. Two loaded close together leave at least `gap` ticks apart, so
   * they are never fired into each other.
   */
  _cannon(m, c, i) {
    // ONCE per marble, except a `refire` launcher (the Moon Shot rocket): a
    // marble knocked back into the rocket's cup in mid-air sat there for good
    // (one race in 300), so that one re-fires anything that returns, after a
    // half-second cooldown. The plain cannons stay once-only: re-firing let
    // one throw a marble into its own breech for ever.
    const st = this.cannonState[i];
    const was = st.until[m.index];
    if (was !== undefined && (!c.refire || this.tick < was)) return false;
    const dx = m.x - c.x, dy = m.y - c.y;
    if (dx * dx + dy * dy >= c.catch * c.catch) return false;
    // A fuse of random length when `delayHi` is set (a bridge's confirmation
    // time, a rocket's countdown), fixed by the tick it was loaded on.
    const delay = (c.delayHi ? Math.round(c.delay + (c.delayHi - c.delay) * tickNoise(this.tick, 7 + i)) : c.delay) +
      this._wornExtra(st.served++, c.wk);
    const fire = Math.max(this.tick + delay, st.last + (c.gap ?? 60));
    st.last = fire;
    st.until[m.index] = fire + 120;
    // A TELEPORT (a bridge) holds the marble at the entrance and releases it
    // from the far end; a cannon holds it in the barrel.
    const hx = c.teleport ? c.x : c.mx, hy = c.teleport ? c.y : c.my;
    m.held = { x: hx, y: hy, vx: c.vx, vy: c.vy, fire, cannon: i, from: this.tick, teleport: !!c.teleport, ox: c.mx, oy: c.my };
    m.x = hx; m.y = hy; m.vx = 0; m.vy = 0;
    this.events.push({ type: 'load', index: m.index, kind: c.kind || 'cannon', secs: +((fire - this.tick) / 240).toFixed(1) });
    return true;
  }

  /** A pulse well's pull on marble m right now, 0..1 of full (for drawing). */
  wellPull(i, m) {
    const z = this.track.zones[i], P = z.pulse;
    if (!P || !(this.zoneUsed[i] & (1 << m.index))) return 0;
    const slot = i * 8 + m.index, a = this.tick - this.wellT[slot];
    if (a >= P.end || m.finished || m.out) return 0;
    const dx = z.cx - m.x, dy = z.cy - m.y;
    if (dx * dx + dy * dy >= z.rad * z.rad) return 0;
    return this.wellK[slot] * (a < P.rise ? a / P.rise : a < P.hold ? 1 : (P.end - a) / (P.end - P.hold));
  }

  /**
   * Extra hold, in ticks, for the (n+1)th marble a worn hold takes. `k`
   * scales it for an element in the late part of the course (see
   * TUNE.wear.late): the extra AND its step, so it still runs out by the
   * same marble.
   */
  _wornExtra(n, k = 1) {
    return this.holdExtra ? Math.max(0, Math.round((this.holdExtra - this.holdStep * n) * k)) : 0;
  }

  /** How many marbles a once-per-marble element has already taken. */
  _served(mask) {
    let n = 0;
    for (let b = mask; b; b &= b - 1) n++;
    return n;
  }

  _regrouping(m) {
    const R = this.track.regroups;
    if (!R) return false;
    for (let i = 0; i < R.length; i++) {
      const g = R[i];
      if (!this.regroupState[i].open && m.x >= g.x0 && m.x <= g.x1 && m.y >= g.y0 && m.y <= g.y1) return true;
    }
    return false;
  }

  _holding(m) {
    const hs = this.track.holds;
    if (hs) {
      // 40 above the waiting area too: a marble stacked on one that is
      // waiting at a shut laser or cup is waiting as well.
      for (const o of hs) {
        if (m.x >= o.x0 && m.x <= o.x1 && m.y >= o.y0 - 40 && m.y <= o.y1 && !this.timedGateOpen(o.gate)) return true;
      }
    }
    // Queued at a cannon that is holding another marble: next in line. With
    // worn fuses up to 2.5s, such a marble sat still past the 2.2s stuck
    // limit and was "rescued" out of its turn (10% of Cannons appearances).
    const cs = this.track.cannons;
    if (cs) {
      for (const o of this.marbles) {
        if (!o.held || o.held.cannon === undefined) continue;
        const c = cs[o.held.cannon], dx = m.x - c.x, dy = m.y - c.y, r = c.catch + 48;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }

  /**
   * Nudge a marble that has stopped moving.
   *
   * Tests whether the marble has MOVED, not whether it has made progress: on a
   * shallow chute a marble legitimately traverses sideways for a second or two
   * with its y barely changing, and nothing at all is wrong.
   */
  _unstick(h) {
    for (const m of this.marbles) {
      if (m.finished || m.out) continue;
      // TRUE 2D displacement, not the drop in y. Measuring y alone is
      // measuring PROGRESS, and on a shallow ramp a marble traverses most of
      // the width with barely any drop, moving perfectly well, and nudged
      // for it. The 3D build learned the same thing on its landing aprons.
      // MOVING BUT GOING NOWHERE. The test below is for a marble that has
      // stopped; a marble can also be trapped while moving, bounced for ever
      // on a peg's crown by a vent, or pinging between a pop bumper and a
      // ramp. No new progress down the course in LOITER_TICKS is that: shove
      // it sideways and on. Long enough that no section's own holds (a 2s
      // freeze, a queue at a turnstile) come near it.
      if (!m.frozen && !m.held && !this._regrouping(m) && this.tick - (m.bestTick ?? 0) > LOITER_TICKS) {
        m.vx += (this.rng() < 0.5 ? -1 : 1) * (260 + this.rng() * 200);
        m.vy += 200;
        m.bestTick = this.tick;
        this.nudges++;
        this.events.push({ type: 'nudge', index: m.index, why: 'loiter', x: m.x, y: m.y });
        continue;
      }
      // Waiting at a shut Mempool floor, frozen, or loaded is not being stuck.
      if (m.frozen || m.held || m.wellUntil > this.tick || this._holding(m) || this._regrouping(m)) { m.stuckX = m.x; m.stuckY = m.y; m.stuckTime = 0; continue; }
      const dx = m.x - m.stuckX, dy = m.y - m.stuckY;
      if (dx * dx + dy * dy > STUCK_MOVE * STUCK_MOVE) {
        m.stuckX = m.x; m.stuckY = m.y;
        m.stuckTime = 0;
        continue;
      }
      m.stuckTime += h;
      // ONE grace period for everyone, deliberately.
      //
      // A marble balanced on a dome's apex is in an exact equilibrium, the
      // contact normal is straight up, so gravity has no tangential component
      // and it will sit there all day. Tempting, then, to rescue a stationary
      // marble faster than a creeping one. Measured both ways: a short window
      // for "stopped" marbles DOUBLED the intervention rate, because plenty of
      // marbles are briefly stationary at the top of a bounce and would have
      // freed themselves. Fewer interventions beats shorter pauses in a race
      // that money is riding on.
      if (m.stuckTime < STUCK_LIMIT) continue;

      // A second rescue in the same spot means the push down and sideways did
      // not free it (a marble in a cup is pushed deeper by it): lift it out,
      // harder each time.
      const again = m.lastNudge && (m.x - m.lastNudge.x) ** 2 + (m.y - m.lastNudge.y) ** 2 < 40 * 40;
      const k = again ? m.lastNudge.k + 1 : 0;
      m.vx += this.rng.spread(260);
      m.vy += again ? -(380 + 160 * Math.min(k, 4)) : 150 + this.rng() * 120;
      m.lastNudge = { x: m.x, y: m.y, k };
      m.stuckX = m.x; m.stuckY = m.y;
      m.stuckTime = 0;
      m.bestTick = this.tick;
      this.nudges++;
      this.events.push({ type: 'nudge', index: m.index, why: 'stopped', x: m.x, y: m.y });
    }
  }

  /**
   * Finished first, by time; then everyone still running, by distance; then
   * the knocked out, LAST OUT RANKING HIGHEST. Surviving longer is the only
   * fair way to separate two marbles that never reached the line.
   */
  standings() {
    const rank = (m) => m.finished ? 0 : m.out ? 2 : 1;
    return this.marbles.slice().sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return a.finishTime - b.finishTime;
      if (ra === 2) return b.outTime - a.outTime;
      return b.progress - a.progress;
    });
  }
}

/**
 * Run one whole race to completion with no rendering.
 *
 * Returns the finishing order and the diagnostics the section bench reads.
 */
export function runRace2D({ engine, maxSeconds = 90 }) {
  const order = [];
  let guard = Math.ceil(maxSeconds / SIM_DT);

  engine.settle();
  engine.openGate();
  while (guard-- > 0 && !engine.allFinished) {
    engine.step(true);
    for (const m of engine.marbles) {
      if (m.finished && !order.includes(m.index)) order.push(m.index);
    }
  }
  const finished = order.length;

  // The knocked-out rank behind every finisher, last out highest. That makes
  // `finishOrder` a COMPLETE ranking of all five in every race, which is what
  // settlement needs: the pool is split by position, not by who finished.
  const out = engine.marbles.filter(m => m.out)
    .sort((a, b) => b.outTime - a.outTime).map(m => m.index);

  return {
    finishOrder: order.concat(out),
    finished,
    eliminated: out,
    outBy: Object.fromEntries(engine.marbles.filter(m => m.out).map(m => [m.index, m.outBy])),
    time: +engine.time.toFixed(2),
    nudges: engine.nudges,
    order: order.map(i => engine.marbles[i].data.name),
    // Per-racer finish times FROM THIS RUN, so a caller showing the committed
    // result never has to read them back off a different engine.
    times: engine.marbles.map(m => +m.finishTime.toFixed(2)),
    unfinished: engine.marbles.filter(m => !m.finished).map(m => m.data.name),
  };
}
