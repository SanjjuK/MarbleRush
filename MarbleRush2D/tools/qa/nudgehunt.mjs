// Every nudge on full courses: which section, why, where, and a replay seed. N=800 TAG=nh TUNE='{}'
const root = new URL('../../../', import.meta.url).href;
const { makeRng } = await import(root + 'js/rng.js');
const { MARBLE_DATA } = await import(root + 'js/racers.js');
const T = await import(root + 'MarbleRush2D/js/track2d.js');
const { Engine2D } = await import(root + 'MarbleRush2D/js/engine2d.js');
console.warn = () => {};
if (process.env.TUNE) Object.assign(T.TUNE, JSON.parse(process.env.TUNE));
const N = +(process.env.N || 600), tag = process.env.TAG || 'nh';
const bySec = {}, appear = {}; let racesNudged = 0; const samples = [];
for (let r = 0; r < N; r++) {
  const seed = tag + r, rng = makeRng(seed);
  const track = T.buildTrack(rng);
  for (const s of track.sections) appear[s.id] = (appear[s.id] || 0) + 1;
  const e = new Engine2D({ track, rng, racers: MARBLE_DATA });
  e.settle(); e.openGate();
  let g = 480 * 240, any = false;
  while (g-- > 0 && !e.allFinished) {
    e.step(true);
    for (const ev of e.events || []) if (ev.type === 'nudge') {
      const sec = track.sections.find(s => ev.y >= s.y0 && ev.y < s.y1);
      const id = sec ? sec.id : (ev.y < track.sections[0].y0 ? 'pen' : 'runout');
      const k = id + ':' + ev.why;
      bySec[k] = (bySec[k] || 0) + 1; any = true;
      if (samples.filter(s => s.startsWith(id + ' ')).length < 3) samples.push(`${id} ${ev.why} seed=${seed} x=${ev.x.toFixed(0)} dy=${sec ? (ev.y - sec.y0).toFixed(0) : '-'} t=${e.time.toFixed(1)}`);
    }
  }
  if (any) racesNudged++;
}
console.log(`races ${N}, with any nudge ${racesNudged} (${(100 * racesNudged / N).toFixed(1)}%)`);
const rows = Object.entries(bySec).map(([k, v]) => { const id = k.split(':')[0]; return [k, v, appear[id] || 0]; }).sort((a, b) => b[1] - a[1]);
for (const [k, v, a] of rows) console.log(k.padEnd(28), String(v).padStart(4), ' per appearance', a ? (100 * v / a).toFixed(1) + '%' : '-');
console.log('\nsamples (replay with seednudge.mjs <seed>):'); for (const s of samples) console.log(' ', s);
