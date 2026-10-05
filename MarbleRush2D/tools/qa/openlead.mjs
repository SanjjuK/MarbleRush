// Who leads out of the opener, by start slot (chi-square vs 20% each, 9.49 = p0.05). OPEN=plinko N=2000 TAG=ox TUNE='{"grid":{...}}'
const root = new URL('../../../', import.meta.url).href;
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
const N = +(process.env.N || 1500), tag = process.env.TAG || 'dl', open = process.env.OPEN || 'plinko';
const lead = [0, 0, 0, 0, 0], spread = [];
for (let r = 0; r < N; r++) {
  const track = T.buildTrack(makeRng(tag + 'c' + r), { only: [open, 'sprint'] });
  const e = new Engine2D({ track, rng: makeRng(tag + 'r' + r), racers: MARBLE_DATA });
  const y1 = track.sections[0].y1, t = [null, null, null, null, null];
  e.settle(); e.openGate();
  let g = 40 * 240;
  while (g-- > 0 && t.some(v => v === null)) {
    e.step(true);
    for (const m of e.marbles) if (t[m.index] === null && m.y >= y1) t[m.index] = e.time;
  }
  if (t.some(v => v === null)) continue;
  const first = t.indexOf(Math.min(...t));
  lead[e.marbles[first].lane]++; spread.push(Math.max(...t) - Math.min(...t));
}
const n = lead.reduce((a, b) => a + b, 0), exp = n / 5;
const chi = lead.reduce((a, o) => a + (o - exp) ** 2 / exp, 0);
spread.sort((a, b) => a - b);
console.log(open.padEnd(14), 'lead%', lead.map(v => String(Math.round(100 * v / n)).padStart(3)).join(' '), ' chi', chi.toFixed(1), ' spread out of opener median', spread[spread.length >> 1].toFixed(2) + 's');
