// probe2d.js: Where does a course trap marbles?
//
//   node MarbleRush2D/tools/probe2d.js --only splitter,sprint --seeds 6
//
// Prints the stall hot-spots, clustered, with the nearest piece of geometry to
// each. A section that nudges is almost always a POCKET, a marble resting in
// a corner between two pieces, or against a wall, and the cluster tells you
// which one without having to watch a race.

import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { buildTrack } from '../js/track2d.js';
import { Engine2D, SIM_DT } from '../js/engine2d.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const only = (arg('only') || '').split(',').filter(Boolean);
const seeds = parseInt(arg('seeds', '6'), 10);

const hits = new Map();

for (let s = 0; s < seeds; s++) {
  const seed = (arg('seed') || 'probe') + s;
  const rng = makeRng(seed);
  const track = buildTrack(rng, { only });
  const engine = new Engine2D({ track, rng, racers: MARBLE_DATA });
  engine.openGate();

  let t = 0;
  while (t < 60 && !engine.allFinished) {
    const before = engine.nudges;
    engine.step(true);
    t += SIM_DT;
    if (engine.nudges === before) continue;

    for (const m of engine.marbles) {
      if (m.finished || m.stuckTime !== 0) continue;
      const key = `${Math.round(m.x / 30) * 30},${Math.round(m.y / 30) * 30}`;
      const rec = hits.get(key) || { n: 0, x: m.x, y: m.y, track };
      rec.n++;
      hits.set(key, rec);
    }
  }
}

if (!hits.size) { console.log('\n  no stalls across', seeds, 'seeds\n'); process.exit(0); }

console.log(`\n  stall hot-spots across ${seeds} seeds (${only.join(' > ') || 'random'})\n`);
for (const [key, rec] of [...hits].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
  const t = rec.track;
  const band = t.sections.find(s => rec.y >= s.y0 && rec.y < s.y1);
  // nearest segment
  let best = null, bestD = Infinity;
  for (const s of t.segments) {
    const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy;
    let u = l2 > 1e-9 ? ((rec.x - s.ax) * dx + (rec.y - s.ay) * dy) / l2 : 0;
    u = Math.max(0, Math.min(1, u));
    const d = Math.hypot(rec.x - (s.ax + u * dx), rec.y - (s.ay + u * dy));
    if (d < bestD) { bestD = d; best = { s, u }; }
  }
  const atEnd = best && (best.u < 0.02 || best.u > 0.98);
  console.log(
    `  x${String(Math.round(rec.x)).padStart(4)} y${String(Math.round(rec.y)).padStart(5)}  ` +
    `x${String(rec.n).padStart(3)}  in ${(band?.id || '-').padEnd(9)} ` +
    `nearest wall ${bestD.toFixed(0)} away` +
    (atEnd ? `  <-- AT A SEGMENT END (pocket)` : ''));
}
console.log('');
