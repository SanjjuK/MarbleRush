// A section after a spreading one: does it close the field, and how often does the leader keep the lead?
//   SECS=gravity,cascade PRE=pinstorm N=200 TUNE='{"wear":{}}' node wearbench.mjs
const root = new URL('../../../', import.meta.url).href;
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
const N = +(process.env.N || 120), secs = (process.env.SECS || 'flippers,pinball,multiball').split(','), pre = process.env.PRE || 'pinstorm';
for (const sec of secs) {
  const byRank = [0, 0, 0, 0, 0].map(() => [0, 0]);
  let kept = 0, swaps = 0, n = 0, nudges = 0, gapIn = 0, gapOut = 0, leadIn = 0, leadOut = 0;
  for (let r = 0; r < N; r++) {
    const rng = makeRng('wb' + sec + r);
    const track = T.buildTrack(rng, { only: ['draw', pre, sec] });
    const e = new Engine2D({ track, rng, racers: MARBLE_DATA });
    const band = track.sections[2];
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
    const live = [0, 1, 2, 3, 4].filter(k => tin[k] !== null && tout[k] !== null);
    if (live.length < 5) continue;
    const oi = live.slice().sort((a, b) => tin[a] - tin[b]), oo = live.slice().sort((a, b) => tout[a] - tout[b]);
    oi.forEach((k, rk) => { byRank[rk][0] += tout[k] - tin[k]; byRank[rk][1]++; });
    const pi = new Map(oi.map((v, i) => [v, i])), po = new Map(oo.map((v, i) => [v, i]));
    for (let x = 0; x < 5; x++) for (let y = x + 1; y < 5; y++) if ((pi.get(x) - pi.get(y)) * (po.get(x) - po.get(y)) < 0) swaps++;
    gapIn += tin[oi[4]] - tin[oi[0]]; gapOut += tout[oo[4]] - tout[oo[0]]; if (oo[0] === oi[0]) kept++;
    leadIn += tin[oi[1]] - tin[oi[0]]; leadOut += tout[oo[1]] - tout[oo[0]];
    n++;
  }
  const f2 = (x) => (x / n).toFixed(2);
  console.log(`${sec.padEnd(10)} n ${n}  swaps ${f2(swaps)}  spread in ${f2(gapIn)} -> out ${f2(gapOut)}  lead(1st-2nd) in ${f2(leadIn)} -> out ${f2(leadOut)}  time by arrival rank ${byRank.map(([a, c]) => (a / c).toFixed(2)).join(' ')}  leader kept ${(100 * kept / n).toFixed(0)}%  nudges ${nudges}`);
}
