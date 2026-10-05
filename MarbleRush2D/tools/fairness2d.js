// fairness2d.js: Is the game actually fair, and does every race finish?
//
//   node MarbleRush2D/tools/fairness2d.js --races 300
//
// This is not a nice-to-have on a parimutuel product. Two things here would
// each be a standing edge for anyone who noticed them before we did:
//
//   1. A racer that wins more than chance. The first run of this found exactly
//      that. Bullion 28.5% against Blaze 12.8%, chi-square 20.0, because
//      the field spawned in fixed index order, so the same marble always drew
//      the outside lane. Fixed by drawing for grid position from the seed.
//   2. A race that cannot finish. 25 of the first 300 hung in the bowl, and a
//      race with no result is a pool that cannot be settled.
//
// The chi-square is against a uniform 20% win rate on 4 degrees of freedom;
// 9.49 is the 5% significance point. Above that, investigate before shipping.

import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { buildTrack, OVERFLOW } from '../js/track2d.js';
import { Engine2D, runRace2D } from '../js/engine2d.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const N = parseInt(arg('races', '300'), 10);
const tag = arg('tag', 'fair');

const wins = MARBLE_DATA.map(() => 0);
// By START SLOT too, Sanjay's ask: which racer won is not enough, a course
// could favour the left corner or the middle and hide it behind the random
// draw for slots. 0 = left wall ... 4 = right wall.
const SLOTS = ['left corner', '2nd left', 'middle', '2nd right', 'right corner'];
const slotWins = SLOTS.map(() => 0), slotPod = SLOTS.map(() => 0), slotTop2 = SLOTS.map(() => 0);
const podium = MARBLE_DATA.map(() => 0);
const sectionUse = {};
let dnf = 0, nudged = 0, tSum = 0, tMin = 1e9, tMax = 0;
const outs = [0, 0, 0];
const slow = [];

for (let i = 0; i < N; i++) {
  const seed = tag + i;
  const rng = makeRng(seed);
  const track = buildTrack(rng);
  track.layout.forEach(id => sectionUse[id] = (sectionUse[id] || 0) + 1);
  const engine = new Engine2D({ track, rng, racers: MARBLE_DATA });
  const r = runRace2D({ engine, maxSeconds: 480 });

  // A knocked-out marble is a RESULT, not a failure: only a marble that
  // neither finished nor was knocked out is a DNF.
  if (r.finished + r.eliminated.length < MARBLE_DATA.length) {
    dnf++;
    console.log(`  DNF  ${seed}  ${r.finished}/5  ${track.layout.join(' > ')}` +
                `   stuck: ${r.unfinished.join(', ')}`);
    continue;
  }
  if (r.nudges) nudged++;
  outs[r.eliminated.length]++;
  if (r.time > 300) slow.push(`${seed} ${r.time}s ${track.layout.join(' > ')}`);
  wins[r.finishOrder[0]]++;
  r.finishOrder.slice(0, 3).forEach(k => podium[k]++);
  const lane = (k) => engine.marbles[k].lane;
  slotWins[lane(r.finishOrder[0])]++;
  r.finishOrder.slice(0, 2).forEach(k => slotTop2[lane(k)]++);
  r.finishOrder.slice(0, 3).forEach(k => slotPod[lane(k)]++);
  tSum += r.time; tMin = Math.min(tMin, r.time); tMax = Math.max(tMax, r.time);
}

const ok = N - dnf;
console.log(`\n  races ${N}   finished ${ok}   with any nudge ${nudged}   DNF ${dnf}`);
console.log(`  time  avg ${(tSum / ok).toFixed(1)}s   min ${tMin.toFixed(1)}s   max ${tMax.toFixed(1)}s`);
console.log(`  knocked out 0/1/2 per race: ${outs.join('/')}`);
if (slow.length) console.log('  slow races:\n    ' + slow.join('\n    '));

console.log('\n  racer      wins    win%   podium%      (fair = 20% / 60%)');
MARBLE_DATA.forEach((d, i) => {
  console.log(`   ${d.name.padEnd(9)} ${String(wins[i]).padStart(5)}  ` +
    `${(wins[i] / ok * 100).toFixed(1).padStart(6)}%  ${(podium[i] / ok * 100).toFixed(1).padStart(7)}%`);
});

const exp = ok / MARBLE_DATA.length;
const chi = wins.reduce((a, w) => a + (w - exp) ** 2 / exp, 0);
const slotChi = slotWins.reduce((a, w) => a + (w - exp) ** 2 / exp, 0);
console.log('\n  start slot       wins    win%   paid (top 2)%   podium%');
SLOTS.forEach((n, i) => console.log(`   ${n.padEnd(13)} ${String(slotWins[i]).padStart(5)}  ${(slotWins[i] / ok * 100).toFixed(1).padStart(6)}%` +
  `  ${(slotTop2[i] / ok * 100).toFixed(1).padStart(10)}%  ${(slotPod[i] / ok * 100).toFixed(1).padStart(8)}%`));
console.log(`  start-slot chi-square ${slotChi.toFixed(2)} (9.49 = p0.05) -> ${slotChi < 9.49 ? 'no slot advantage' : 'A SLOT IS FAVOURED'}`);
console.log(`\n  chi-square ${chi.toFixed(2)} on 4 dof (9.49 = p0.05) -> ` +
            `${chi < 9.49 ? 'indistinguishable from fair' : 'BIASED, do not ship'}`);
console.log(`  section usage: ${JSON.stringify(sectionUse)}`);
const over = [...new Set(OVERFLOW)];
if (over.length) console.log('  SECTIONS DRAWING OUTSIDE THEIR BAND:\n    ' + over.join('\n    '));
console.log(`  verdict: ${dnf === 0 && chi < 9.49 && slotChi < 9.49 && !over.length ? 'PASS' : 'NEEDS WORK'}\n`);
