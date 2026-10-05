// shuffle2d.js: How much does one section reshuffle a field that arrives
// together? The number the course builder uses to pick finale sections.
//
//   node MarbleRush2D/tools/shuffle2d.js windmills turbine pegs [--races 60]
//
// Each race is The Draw (a fair, random start) then the section. Measured
// between the section's entry and its exit:
//   swaps    pairs of marbles whose order flipped, of 10 (random = 5)
//   lead     how often the marble leading in is still leading out (random 20%)
//   spread   first-to-last seconds, in -> out
//   secs     average time through
import { recordRace } from './drama2d.js';
import { TUNE } from '../js/track2d.js';
if (process.env.TUNE) Object.assign(TUNE, JSON.parse(process.env.TUNE));

const argv = process.argv.slice(2);
const ri = argv.indexOf('--races');
const N = ri >= 0 ? +argv[ri + 1] : 60;
const ids = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--races');
const K = 5;
for (const id of ids) {
  let swaps = 0, kept = 0, sIn = 0, sOut = 0, secs = 0, n = 0;
  for (let r = 0; r < N; r++) {
    const R = recordRace('sh' + id + r, { only: ['draw', id] });
    if (R.cross.length < 3) { console.log(`${id}: not built`); break; }
    const a = R.cross[1], b = R.cross[2];
    const live = [...Array(K).keys()].filter(i => a[i] !== null && b[i] !== null);
    if (live.length < 2) continue;
    const oa = live.slice().sort((x, y) => a[x] - a[y]), ob = live.slice().sort((x, y) => b[x] - b[y]);
    const pa = new Map(oa.map((v, i) => [v, i])), pb = new Map(ob.map((v, i) => [v, i]));
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const x = live[i], y = live[j];
      if ((pa.get(x) - pa.get(y)) * (pb.get(x) - pb.get(y)) < 0) swaps++;
    }
    if (oa[0] === ob[0]) kept++;
    const sp = (t) => Math.max(...live.map(i => t[i])) - Math.min(...live.map(i => t[i]));
    sIn += sp(a); sOut += sp(b);
    secs += live.reduce((acc, i) => acc + b[i] - a[i], 0) / live.length;
    n++;
  }
  console.log(`${id.padEnd(13)} swaps ${(swaps / n).toFixed(2).padStart(5)}/10   lead kept ${(100 * kept / n).toFixed(0).padStart(3)}%` +
              `   spread ${(sIn / n).toFixed(2)} -> ${(sOut / n).toFixed(2)}s   ${(secs / n).toFixed(1)}s through`);
}
