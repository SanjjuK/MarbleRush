// Every flipper throw: which throw it was, flipper length, launch speed, how
// high the marble rose, and whether it went back above its section's start
// or past the middle of the section before (a throw must never send a marble
// two sections back). N=150 races per section; TUNE='{"wear":{"flip":{...}}}'.
const root = new URL('../../../', import.meta.url).href;
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
const N = +(process.env.N || 150);
const byOrd = {}; const rises = []; let back = 0, back2 = 0, total = 0;
for (const sec of ['pinball', 'multiball']) for (let r = 0; r < N; r++) {
  const rng = makeRng('th' + sec + r);
  const track = T.buildTrack(rng, { only: ['draw', 'pinstorm', sec] });
  const e = new Engine2D({ track, rng, racers: MARBLE_DATA });
  const band = track.sections[2], prev = track.sections[1];
  e.settle(); e.openGate();
  const prevKick = e.flips.map(() => 0), open = [];
  let g = 120 * 240;
  while (g-- > 0 && !e.allFinished) {
    e.step(true);
    e.flips.forEach((s, i) => {
      const nb = s.kicked & ~prevKick[i];
      if (nb) for (let k = 0; k < 5; k++) if (nb & (1 << k)) {
        let ord = 0; for (let b = prevKick[i]; b; b &= b - 1) ord++;
        const m = e.marbles[k];
        open.push({ m, y: m.y, ord: ord + 1, len: s.len, until: e.tick + 720, vmax: 0, ymin: m.y, from: e.tick });
      }
      prevKick[i] = s.kicked;
    });
    for (const o of open) if (e.tick <= o.until) {
      if (e.tick - o.from < 40) o.vmax = Math.max(o.vmax, Math.hypot(o.m.vx, o.m.vy));
      o.ymin = Math.min(o.ymin, o.m.y);
    }
  }
  for (const o of open) {
    total++;
    const rise = o.y - o.ymin; rises.push(rise);
    if (o.ymin < band.y0) back++;
    if (o.ymin < prev.y0 + (prev.y1 - prev.y0) / 2) back2++;
    (byOrd[o.ord] = byOrd[o.ord] || []).push([o.vmax, rise, o.len]);
  }
}
rises.sort((a, b) => a - b);
const q = (p) => rises[Math.floor(p * (rises.length - 1))].toFixed(0);
console.log(`throws ${total}  rise median ${q(0.5)}  p90 ${q(0.9)}  max ${q(1)}  | back above own section start ${(100 * back / total).toFixed(1)}%  | back past half of the section before ${(100 * back2 / total).toFixed(1)}%`);
for (const k of Object.keys(byOrd)) {
  const a = byOrd[k], avg = (j) => (a.reduce((s, x) => s + x[j], 0) / a.length).toFixed(0);
  console.log(`  throw #${k}: n ${a.length}  flipper len ${avg(2)}  launch speed ${avg(0)}  rise ${avg(1)}`);
}
