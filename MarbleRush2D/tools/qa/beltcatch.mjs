// Belt sections: what share of marbles touches each belt row (a belt that
// catches nothing is decoration), plus the usual shuffle numbers.
//   SEC=orderbook PRE=pinstorm N=200 TUNE='{}' node beltcatch.mjs
const root = '/Users/sanjju/Product ideas/Online Crypto platform/';
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
const N = +(process.env.N || 200), sec = process.env.SEC || 'orderbook', pre = process.env.PRE || 'pinstorm';
let touched = null, swaps = 0, kept = 0, n = 0, nudges = 0, spIn = 0, spOut = 0, secs = 0, stuckSecs = 0;
for (let r = 0; r < N; r++) {
  const rng = makeRng('bc' + sec + r);
  const track = T.buildTrack(rng, { only: ['draw', pre, sec] });
  const e = new Engine2D({ track, rng, racers: MARBLE_DATA });
  const band = track.sections[2];
  const belts = track.segments.filter(s => s.belt !== undefined && s.ay >= band.y0 && s.ay < band.y1);
  const rows = [...new Set(belts.map(s => Math.round((s.ay + s.by) / 2 - band.y0)))].sort((a, b) => a - b);
  const rowOf = new Map(belts.map(s => [s, rows.indexOf(Math.round((s.ay + s.by) / 2 - band.y0))]));
  touched ??= rows.map(() => 0);
  // Real contact only: _belt runs for every marble near a belt, _segment says whether it touched.
  const seen = new Set(), orig = e._segment;
  e._segment = function (m, s, ...a) { const hit = orig.call(this, m, s, ...a); if (hit && s.belt !== undefined && rowOf.has(s)) seen.add(m.index * 16 + rowOf.get(s)); return hit; };
  const tin = Array(5).fill(null), tout = Array(5).fill(null);
  e.settle(); e.openGate();
  let g = 200 * 240;
  while (g-- > 0 && !e.allFinished) {
    e.step(true);
    for (const m of e.marbles) {
      if (tin[m.index] === null && m.y >= band.y0) tin[m.index] = e.time;
      if (tout[m.index] === null && m.y >= band.y1) tout[m.index] = e.time;
    }
  }
  nudges += e.nudges;
  if (tin.some(v => v === null) || tout.some(v => v === null)) continue;
  for (const k of seen) touched[k % 16] += 1;
  const oi = [0, 1, 2, 3, 4].sort((a, b) => tin[a] - tin[b]), oo = [0, 1, 2, 3, 4].sort((a, b) => tout[a] - tout[b]);
  const pi = new Map(oi.map((v, i) => [v, i])), po = new Map(oo.map((v, i) => [v, i]));
  for (let x = 0; x < 5; x++) for (let y = x + 1; y < 5; y++) if ((pi.get(x) - pi.get(y)) * (po.get(x) - po.get(y)) < 0) swaps++;
  if (oo[0] === oi[0]) kept++;
  spIn += tout.reduce((a, v) => Math.max(a, v), 0) - tout.reduce((a, v) => Math.min(a, v), 1e9);
  spOut += tin.reduce((a, v) => Math.max(a, v), 0) - tin.reduce((a, v) => Math.min(a, v), 1e9);
  secs += tout.reduce((a, v, i) => a + v - tin[i], 0) / 5;
  n++;
}
console.log(`${sec} n ${n}  marbles touching each belt row (top to bottom): ${touched.map(v => Math.round(100 * v / (5 * n)) + '%').join(' ')}  swaps ${(swaps / n).toFixed(2)}  spread in ${(spOut / n).toFixed(2)} -> out ${(spIn / n).toFixed(2)}  secs ${(secs / n).toFixed(1)}  leader kept ${Math.round(100 * kept / n)}%  nudges ${nudges}`);
