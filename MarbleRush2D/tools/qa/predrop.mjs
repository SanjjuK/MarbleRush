// How often is a marble already past the start gate when betting opens? Run after ANY grid/gate/opener change. N=400
const root = new URL('../../../', import.meta.url).href;
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
const N = +(process.env.N || 400); let bad = 0; const byOpener = {}, bySlot = [0, 0, 0, 0, 0];
for (let r = 0; r < N; r++) {
  const rng = makeRng('pd' + r);
  const track = T.buildTrack(rng, { count: 8 });
  const e = new Engine2D({ track, rng, racers: MARBLE_DATA });
  e.settle();
  const past = e.marbles.filter(m => m.y > track.gate.ay + 5);
  const op = track.layout[0]; byOpener[op] ??= [0, 0]; byOpener[op][1]++;
  if (past.length) { bad++; byOpener[op][0]++; for (const m of past) bySlot[m.lane]++; }
}
console.log(`races with a marble past the gate before the start: ${bad}/${N}`, JSON.stringify(byOpener), 'by slot', bySlot.join('/'));
