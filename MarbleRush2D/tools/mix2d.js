// mix2d.js: What KIND of section a viewer sees, and where, over many courses.
//
//   node MarbleRush2D/tools/mix2d.js [--courses 1000]
//
// Sanjay: "pinball type elements are appearing at high frequency than other
// elements... should we have a parameter to track and test that?" This is
// that parameter: share of each kind over the whole course and in the final
// 18% (the run-in), and the longest unbroken run of one kind.
import { makeRng } from '../../js/rng.js';
import { buildTrack, KIND, TUNE } from '../js/track2d.js';
// Like drama2d: TUNE='{"mix":{"off":1}}' compares a setting against the defaults.
if (process.env.TUNE) Object.assign(TUNE, JSON.parse(process.env.TUNE));

console.warn = () => {};
const argv = process.argv.slice(2);
const i = argv.indexOf('--courses');
const N = i >= 0 ? +argv[i + 1] : 1000;
const all = {}, late = {}, run = {};
let blocks = 0, lateBlocks = 0, maxRunSum = 0;
for (let r = 0; r < N; r++) {
  const ids = buildTrack(makeRng('mix' + r)).sections.map(s => s.id);
  let cur = '', len = 0, best = 0;
  ids.forEach((id, k) => {
    const kind = KIND[id];
    all[kind] = (all[kind] || 0) + 1; blocks++;
    if (k / ids.length >= 0.82) { late[kind] = (late[kind] || 0) + 1; lateBlocks++; }
    len = kind === cur ? len + 1 : 1; cur = kind;
    if (len > best) best = len;
    run[kind] = Math.max(run[kind] || 0, len);
  });
  maxRunSum += best;
}
const kinds = Object.keys(all).sort((a, b) => all[b] - all[a]);
console.log(`courses ${N}, ${(blocks / N).toFixed(0)} sections each\n`);
console.log('kind      whole course   run-in (last 18%)   longest run seen');
for (const k of kinds) {
  console.log(`${k.padEnd(9)} ${(100 * all[k] / blocks).toFixed(0).padStart(8)}%   ${(100 * (late[k] || 0) / lateBlocks).toFixed(0).padStart(12)}%   ${String(run[k]).padStart(12)}`);
}
console.log(`\nlongest run of one kind per course, average ${(maxRunSum / N).toFixed(1)}`);
