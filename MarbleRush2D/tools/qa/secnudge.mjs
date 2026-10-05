// Nudges inside ONE section on a short course. SEC=gravity PRE=pinstorm|none N=200
const root = new URL('../../../', import.meta.url).href;
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
const N = +(process.env.N || 200), sec = process.env.SEC || 'gravity', pre = process.env.PRE || 'pinstorm';
let races = 0;
for (let r = 0; r < N; r++) {
  const seed = 'wb' + sec + r, rng = makeRng(seed);
  const track = T.buildTrack(rng, { only: pre === 'none' ? ['draw', sec] : ['draw', pre, sec] });
  const e = new Engine2D({ track, rng, racers: MARBLE_DATA });
  const band = track.sections[track.sections.length - 1];
  e.settle(); e.openGate();
  let g = 200 * 240, any = false;
  while (g-- > 0 && !e.allFinished) {
    e.step(true);
    for (const ev of e.events) if (ev.type === 'nudge') { any = true; console.log(seed, ev.why, 'x', ev.x.toFixed(0), 'dy', (ev.y - band.y0).toFixed(0), 't', e.time.toFixed(1)); }
  }
  if (any) races++;
}
console.log('races nudged', races, 'of', N);
