// For each loiter rescue on a full-course seed: how far behind its best point was the marble, and had a
// flipper thrown it? A marble far behind its best after a throw is on its way back, not trapped.
//   node loiterwhy.mjs nl229 nl699 ...
const root = '/Users/sanjju/Product ideas/Online Crypto platform/';
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
for (const seed of process.argv.slice(2)) {
  const rng = makeRng(seed), track = T.buildTrack(rng), e = new Engine2D({ track, rng, racers: MARBLE_DATA });
  e.settle(); e.openGate();
  const lastThrow = [-1, -1, -1, -1, -1], seen = e.flips.map(() => 0);
  let g = 480 * 240;
  while (g-- > 0 && !e.allFinished) {
    e.step(true);
    e.flips.forEach((s, i) => { const nb = s.kicked & ~seen[i]; if (nb) for (let k = 0; k < 5; k++) if (nb & (1 << k)) lastThrow[k] = e.time; seen[i] = s.kicked; });
    for (const ev of e.events) if (ev.type === 'nudge' && ev.why === 'loiter') {
      const m = e.marbles[ev.index], sec = track.sections.find(s => ev.y >= s.y0 && ev.y < s.y1);
      console.log(`${seed} ${sec?.id} marble ${ev.index} t ${e.time.toFixed(1)}: ${(m.progress - m.y).toFixed(0)} behind its best, last thrown ${lastThrow[ev.index] < 0 ? 'never' : (e.time - lastThrow[ev.index]).toFixed(1) + 's ago'}`);
    }
  }
}
