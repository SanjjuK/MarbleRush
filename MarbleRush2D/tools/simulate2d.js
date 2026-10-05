// simulate2d.js: Run 2D races headless, in Node, with no browser anywhere.
//
// This is the authoritative result. The browser's job is to replay it.
//
//   node MarbleRush2D/tools/simulate2d.js --seed a1b2c3
//   node MarbleRush2D/tools/simulate2d.js --only pegs --races 5
//   node MarbleRush2D/tools/simulate2d.js --only chutes,bowl,sprint
//   node MarbleRush2D/tools/simulate2d.js --bench          # every section alone
//
// The same seed must always give the same finishing order, so `--races` with
// one fixed seed is a determinism check and not just a soak.

import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { buildTrack, SECTIONS } from '../js/track2d.js';
import { Engine2D, runRace2D } from '../js/engine2d.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

const only  = (arg('only') || '').split(',').filter(Boolean);
const races = parseInt(arg('races', '1'), 10);
const maxS  = parseFloat(arg('max', '480'));
const count = parseInt(arg('count', '58'), 10);

function runOne(seed, sections) {
  // One rng drives the course AND the race, exactly as the page will do it,
  // so a seed identifies a whole race and not just its physics.
  const rng = makeRng(seed);
  const track = buildTrack(rng, { only: sections, count });
  const engine = new Engine2D({ track, rng, racers: MARBLE_DATA });
  const r = runRace2D({ engine, maxSeconds: maxS });
  return { ...r, layout: track.layout, height: track.height, seed };
}

function report(label, r) {
  // A knocked-out marble is a RESULT, not a failure: only a marble that
  // neither finished nor was knocked out means the course did not work.
  const out = r.eliminated || [];
  const accounted = r.finished + out.length === MARBLE_DATA.length;
  const ok = accounted && r.nudges === 0;
  const tag = ok ? 'PASS' : accounted ? 'WARN' : 'FAIL';
  const outNames = out.map(i => MARBLE_DATA[i].name);
  const dnf = r.unfinished.filter(n => !outNames.includes(n));
  console.log(
    `  ${tag}  ${String(label).padEnd(30)} ${r.finished}/${MARBLE_DATA.length} ` +
    `in ${String(r.time).padStart(6)}s  nudges ${String(r.nudges).padStart(3)}  ` +
    `${r.order.join(' > ')}` +
    (outNames.length ? `   [out: ${outNames.join(', ')}]` : '') +
    (dnf.length ? `   [dnf: ${dnf.join(', ')}]` : '')
  );
  return ok;
}

if (has('bench')) {
  // Every section on its own, with the run-in after it so there is always a
  // finish line to reach. A section that cannot be crossed shows up here and
  // nowhere else.
  console.log('\n  Section bench, each block alone, then the run-in\n');
  let bad = 0;
  for (const s of SECTIONS) {
    if (s.id === 'sprint') continue;
    const r = runOne(arg('seed', 'bench'), [s.id, 'sprint']);
    if (!report(`${s.id}  (${s.label})`, r)) bad++;
  }
  const r = runOne(arg('seed', 'bench'), ['sprint']);
  if (!report('sprint  (Final Sprint)', r)) bad++;
  console.log(`\n  ${bad === 0 ? 'all sections clean' : bad + ' section(s) need work'}\n`);
  process.exit(0);
}

const seed = arg('seed', 'demo');
const results = [];
for (let i = 0; i < races; i++) {
  results.push(runOne(races > 1 && !arg('seed') ? seed + i : seed, only));
}

console.log('');
console.log('  course:', results[0].layout.join(' > '));
console.log('  height:', results[0].height);
console.log('');
for (const r of results) report(r.seed, r);

if (races > 1 && arg('seed')) {
  const key = (r) => r.finishOrder.join(',') + '|' + r.time;
  const stable = results.every(r => key(r) === key(results[0]));
  console.log(`\n  determinism (same seed x${races}): ${stable ? 'STABLE' : 'DIVERGED'}`);
}
console.log('');
