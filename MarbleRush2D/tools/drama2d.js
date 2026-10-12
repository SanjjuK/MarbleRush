// drama2d.js: Is the race still open in the second half?
//
//   node MarbleRush2D/tools/drama2d.js --races 200 [--tag drama] [--sections]
//
// Playtest note, after watching races: "after half point it's certain which marble
// is going to win". Fairness says every marble wins 20% of the time; it says
// nothing about WHEN the race is decided. A race whose winner is obvious at
// the halfway mark is fair and boring, and on a betting product boring is a
// bettor who stops watching.
//
// Every section boundary is a checkpoint. The order marbles first cross it is
// the race order there. From that:
//
//   decided at   the last checkpoint where the eventual winner was NOT in the
//                lead, as a fraction of the course. Late is good.
//   leader wins  how often the leader at 50% / 75% / 90% goes on to win.
//                Fair and dead random would be 20%; real racing lives around
//                35-50%. 80%+ is "certain after halfway".
//   lead changes after halfway, per race.
//   spread       seconds from first to last across a checkpoint: a field
//                strung out over 20s cannot swap places, however wild the
//                section.
//   by lane      start slot 0 (left wall) .. 4 (right wall): wins, and who
//                leads after the opening. The opening must not hand a lane
//                the lead.
//
// --sections adds a per-section table: how much each section SHUFFLES (pairs
// that swap order between its entry and its exit) and how much it SPREADS the
// field. That table is what the course builder uses to put mixers late and
// keep spreaders early.

import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { buildTrack } from '../js/track2d.js';
import { Engine2D } from '../js/engine2d.js';
import { TUNE } from '../js/track2d.js';
if (process.env.TUNE) Object.assign(TUNE, JSON.parse(process.env.TUNE));

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const N = parseInt(arg('races', '200'), 10);
const tag = arg('tag', 'drama');
const perSection = argv.includes('--sections');
const only = arg('only', null);
const count = arg('count', null);
const SIM_DT = 1 / 240;

const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '%' : '-';
const K = MARBLE_DATA.length;

/** Run one race, recording when each marble first crosses each checkpoint y. */
export function recordRace(seed, opts = {}) {
  const rng = makeRng(seed);
  const track = buildTrack(rng, opts);
  const engine = new Engine2D({ track, rng, racers: MARBLE_DATA });
  const cps = track.sections.map(s => s.y0).concat(track.finishY);
  const cross = cps.map(() => new Array(K).fill(null));
  engine.settle();
  engine.openGate();
  let guard = Math.ceil(480 / SIM_DT);
  while (guard-- > 0 && !engine.allFinished) {
    engine.step(true);
    for (const m of engine.marbles) {
      if (m.out) continue;
      for (let c = 0; c < cps.length; c++) {
        if (cross[c][m.index] === null && m.y >= cps[c]) cross[c][m.index] = engine.time;
      }
    }
  }
  // A marble warped FORWARD skips checkpoints: it takes the time it landed.
  // A marble knocked out stays null from there on and ranks behind.
  const lanes = engine.marbles.map(m => m.lane);
  const orderAt = (c) => {
    const t = cross[c];
    return [...Array(K).keys()].filter(i => t[i] !== null).sort((a, b) => t[a] - t[b]);
  };
  const finish = orderAt(cps.length - 1);
  const outs = engine.marbles.filter(m => m.out).sort((a, b) => b.outTime - a.outTime).map(m => m.index);
  return { track, cps, cross, orderAt, finish: finish.concat(outs.filter(i => !finish.includes(i))),
           lanes, time: engine.time, nudges: engine.nudges };
}

/** Pairs of marbles (both present at both points) whose order differs. */
function swaps(a, b) {
  const pa = new Map(a.map((v, i) => [v, i])), pb = new Map(b.map((v, i) => [v, i]));
  const both = a.filter(v => pb.has(v));
  let s = 0;
  for (let i = 0; i < both.length; i++) for (let j = i + 1; j < both.length; j++) {
    const x = both[i], y = both[j];
    if ((pa.get(x) - pa.get(y)) * (pb.get(x) - pb.get(y)) < 0) s++;
  }
  return s;
}

function main() {
  const marks = [0.25, 0.5, 0.75, 0.9];
  const leaderWins = marks.map(() => 0);
  const top2Holds = marks.map(() => 0);
  const spreadAt = marks.map(() => 0);
  let decidedSum = 0, lateDecided = 0, changesSum = 0, swapsSum = 0;
  let allChanges = 0, minutes = 0, leaders = 0, noChange = 0;
  const laneWins = new Array(K).fill(0), lanePodium = new Array(K).fill(0), laneOpenLead = new Array(K).fill(0);
  const sec = {};
  const decidedHist = new Array(10).fill(0);

  for (let r = 0; r < N; r++) {
    const R = recordRace(tag + r, { ...(only ? { only: only.split(',') } : {}), ...(count ? { count: +count } : {}) });
    const n = R.cps.length;
    const orders = R.cps.map((_, c) => R.orderAt(c));
    const winner = R.finish[0];
    const at = (f) => Math.min(n - 1, Math.round(f * (n - 1)));

    marks.forEach((f, k) => {
      const o = orders[at(f)];
      if (o[0] === winner) leaderWins[k]++;
      const t2 = new Set(R.finish.slice(0, 2));
      if (o.length >= 2 && t2.has(o[0]) && t2.has(o[1])) top2Holds[k]++;
      const t = R.cross[at(f)].filter(v => v !== null);
      spreadAt[k] += Math.max(...t) - Math.min(...t);
    });

    let decided = 0;
    for (let c = 0; c < n - 1; c++) if (orders[c][0] !== winner) decided = c + 1;
    const frac = decided / (n - 1);
    decidedSum += frac;
    decidedHist[Math.min(9, Math.floor(frac * 10))]++;
    if (frac >= 0.75) lateDecided++;

    // Lead changes over the WHOLE race, at every section boundary, and how
    // many different marbles led at some point.
    let all = 0;
    const led = new Set([orders[0][0]]);
    for (let c = 1; c < n; c++) if (orders[c][0] !== orders[c - 1][0]) { all++; led.add(orders[c][0]); }
    allChanges += all; leaders += led.size; if (!all) noChange++;
    minutes += R.time / 60;

    let changes = 0;
    for (let c = at(0.5) + 1; c < n; c++) if (orders[c][0] !== orders[c - 1][0]) changes++;
    changesSum += changes;
    swapsSum += swaps(orders[at(0.5)], orders[n - 1]);

    const laneOf = (i) => R.lanes[i];
    laneWins[laneOf(winner)]++;
    R.finish.slice(0, 2).forEach(i => lanePodium[laneOf(i)]++);
    laneOpenLead[laneOf(orders[Math.min(2, n - 1)][0])]++;

    if (perSection) {
      for (let c = 0; c < n - 1; c++) {
        const id = R.track.sections[c].id;
        const s = sec[id] || (sec[id] = { n: 0, swaps: 0, spreadIn: 0, spreadOut: 0, secs: 0 });
        const a = R.cross[c], b = R.cross[c + 1];
        const live = [...Array(K).keys()].filter(i => a[i] !== null && b[i] !== null);
        if (live.length < 2) continue;
        s.n++;
        s.swaps += swaps(live.slice().sort((x, y) => a[x] - a[y]), live.slice().sort((x, y) => b[x] - b[y]));
        const sp = (t) => Math.max(...live.map(i => t[i])) - Math.min(...live.map(i => t[i]));
        s.spreadIn += sp(a); s.spreadOut += sp(b);
        s.secs += live.reduce((acc, i) => acc + b[i] - a[i], 0) / live.length;
      }
    }
    if ((r + 1) % 50 === 0) process.stderr.write(`  ${r + 1}/${N}\n`);
  }

  console.log(`\n  races ${N}\n`);
  console.log('  course point         25%    50%    75%    90%');
  console.log('  leader goes on to win ' + leaderWins.map(v => pct(v, N).padStart(5)).join('  ') + '    (random 20%, gripping 35-50%)');
  console.log('  top 2 already set    ' + top2Holds.map(v => pct(v, N).padStart(5)).join('  ') + '    (random 10%)');
  console.log('  field spread, s      ' + spreadAt.map(v => (v / N).toFixed(1).padStart(5)).join('  '));
  console.log(`\n  winner decided at    ${(100 * decidedSum / N).toFixed(0)}% of the course on average`);
  console.log(`  decided in last 25%  ${pct(lateDecided, N)} of races`);
  console.log('  decided-at histogram ' + decidedHist.map((v, i) => `${i * 10}%:${v}`).join(' '));
  console.log(`  lead changes, whole race ${(allChanges / N).toFixed(2)} per race = ${(allChanges / minutes).toFixed(2)} per minute; a lead lasts ${(minutes * 60 / (allChanges + N)).toFixed(0)}s on average`);
  console.log(`  different leaders per race ${(leaders / N).toFixed(2)} of 5; races with ONE leader start to finish ${pct(noChange, N)}`);
  console.log(`  lead changes after halfway ${(changesSum / N).toFixed(2)} per race`);
  console.log(`  place swaps halfway to finish ${(swapsSum / N).toFixed(2)} of 10 pairs per race`);
  console.log('\n  start slot   0 left   1      2 mid   3      4 right');
  console.log('  wins       ' + laneWins.map(v => pct(v, N).padStart(8)).join(''));
  console.log('  top 2      ' + lanePodium.map(v => pct(v, 2 * N).padStart(8)).join('') + '   (of places)');
  console.log('  lead after opening ' + laneOpenLead.map(v => pct(v, N).padStart(6)).join(''));
  const exp = N / K;
  const chi = (arr, e) => arr.reduce((a, v) => a + (v - e) ** 2 / e, 0);
  console.log(`  chi-square: wins ${chi(laneWins, exp).toFixed(2)}, opening lead ${chi(laneOpenLead, exp).toFixed(2)}  (9.49 = p0.05)`);

  if (perSection) {
    console.log('\n  section        n   swaps/10  spread in -> out (s)   secs');
    Object.entries(sec).sort((a, b) => b[1].swaps / b[1].n - a[1].swaps / a[1].n).forEach(([id, s]) => {
      console.log(`  ${id.padEnd(12)} ${String(s.n).padStart(4)}   ${(s.swaps / s.n).toFixed(2).padStart(5)}` +
        `     ${(s.spreadIn / s.n).toFixed(2).padStart(6)} -> ${(s.spreadOut / s.n).toFixed(2).padStart(6)}` +
        `   ${(s.secs / s.n).toFixed(1).padStart(5)}`);
    });
  }
}

if (process.argv[1]?.endsWith("drama2d.js")) main();
