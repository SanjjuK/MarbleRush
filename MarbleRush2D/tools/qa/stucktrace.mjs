// Replay one full-course seed to its first nudge in a section and print what the stuck marble was
// doing (position, speed, layer, whether held) for the 4 seconds before, plus the walls around it.
//   SEED=nh125 SEC=looprow node stucktrace.mjs
const root = '/Users/sanjju/Product ideas/Online Crypto platform/';
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
const seed = process.env.SEED || 'nh125', sec = process.env.SEC || 'looprow';
const rng = makeRng(seed), track = T.buildTrack(rng), e = new Engine2D({ track, rng, racers: MARBLE_DATA });
const band = track.sections.find(s => s.id === sec);
if (!band) { console.log('section not in this course'); process.exit(); }
e.settle(); e.openGate();
const hist = [[], [], [], [], []];
let g = 480 * 240, hit = null;
while (g-- > 0 && !e.allFinished && !hit) {
  e.step(true);
  if (e.tick % 60 === 0) e.marbles.forEach((m, i) => { hist[i].push([e.time, m.x, m.y - band.y0, Math.hypot(m.vx, m.vy), m.layer, m.held ? 'H' : '']); if (hist[i].length > 20) hist[i].shift(); });
  for (const ev of e.events) if (ev.type === 'nudge' && ev.y >= band.y0 && ev.y < band.y1 && !hit) hit = ev;
}
if (!hit) { console.log('no nudge in', sec); process.exit(); }
const m = e.marbles[hit.index];
console.log(`${seed} ${sec}: nudge (${hit.why}) marble ${hit.index} at x ${hit.x.toFixed(0)} dy ${(hit.y - band.y0).toFixed(0)} t ${e.time.toFixed(1)} layer ${m.layer} flip? ${track.sections.indexOf(band)}`);
console.log('last 4s: t, x, dy, speed, layer'); for (const h of hist[hit.index].slice(-17)) console.log(' ', h[0].toFixed(2), h[1].toFixed(0), h[2].toFixed(0), h[3].toFixed(0), 'L' + h[4], h[5]);
console.log('walls within 70 of the stall:');
for (const s of track.segments) {
  const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((hit.x - s.ax) * dx + (hit.y - s.ay) * dy) / l2));
  const d = Math.hypot(hit.x - s.ax - u * dx, hit.y - s.ay - u * dy);
  if (d < 70) console.log(`  (${s.ax.toFixed(0)},${(s.ay - band.y0).toFixed(0)})->(${s.bx.toFixed(0)},${(s.by - band.y0).toFixed(0)}) layer ${s.layer ?? '-'} ${s.boost ? 'BOOST' : ''} dist ${d.toFixed(0)}`);
}
for (const b of track.bumpers) if (Math.hypot(hit.x - b.x, hit.y - b.y) < 70 + b.r) console.log(`  peg r${b.r} at (${b.x.toFixed(0)},${(b.y - band.y0).toFixed(0)})`);
