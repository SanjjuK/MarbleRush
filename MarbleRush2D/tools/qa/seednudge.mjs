// Replay named seeds on full courses and list each nudge: node seednudge.mjs nh6 nh24
const root = new URL('../../../', import.meta.url).href;
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
for (const seed of process.argv.slice(2)) {
  const rng = makeRng(seed), track = T.buildTrack(rng), e = new Engine2D({ track, rng, racers: MARBLE_DATA });
  e.settle(); e.openGate(); let g = 480 * 240; const out = [];
  while (g-- > 0 && !e.allFinished) { e.step(true); for (const ev of e.events) if (ev.type === 'nudge') { const s = track.sections.find(s => ev.y >= s.y0 && ev.y < s.y1); out.push(`${s?.id}@${(ev.y - (s?.y0 ?? 0)).toFixed(0)}`); } }
  console.log(seed, out.join(' ') || 'no nudges');
}
