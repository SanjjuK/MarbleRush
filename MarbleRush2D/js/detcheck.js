// detcheck.js: a determinism fingerprint, for comparing JavaScript engines.
// Runs one short race from fixed seeds and returns positions each second and
// a digest of the course geometry. Node and every browser must agree exactly.
import { makeRng, hashSeed } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { buildTrack } from './track2d.js';
import { Engine2D } from './engine2d.js';

export function fingerprint(course = 'c0', race = 'r0', blocks = 8, secs = 30, only) {
  const t = buildTrack(makeRng(course), only ? { only } : { count: blocks });
  let geo = 0;
  const mix = (v) => { geo = (geo * 31 + Math.round(v * 1e6)) % 2147483647; };
  for (const s of t.segments) { mix(s.ax); mix(s.ay); mix(s.bx); mix(s.by); }
  for (const b of t.bumpers) { mix(b.x); mix(b.y); }
  for (const b of t.bowls) for (const g of b.gaps) { mix(g.cx); mix(g.cy); mix(g.cosHalf); }
  const e = new Engine2D({ track: t, rng: makeRng(race), racers: MARBLE_DATA });
  e.settle(); e.openGate();
  const pos = [];
  for (let i = 1; i <= secs * 240; i++) {
    e.step(true);
    if (i % 240 === 0) pos.push(e.marbles.map(m => m.x.toFixed(6) + ',' + m.y.toFixed(6)).join(' '));
  }
  return { geo, layout: t.layout.join(','), pos };
}

/**
 * A short fingerprint of how THIS JavaScript engine, running THIS copy of the
 * code, races: a fixed course and seed, a few seconds, hashed. The server
 * computes it at start and every browser computes it on connect; if the two
 * differ, the browser cannot replay the server's races and must reload.
 */
export function buildPrint() {
  // A fixed course through every kind of moving rule (flipper and bumper
  // wear, wearing gates and lasers, worn fuses and freezes, swinging wind),
  // so a difference anywhere in them changes the print.
  const f = fingerprint('mr-print-course', 'mr-print-race', 0, 16,
    ['draw', 'pinball', 'lasergrid', 'cannons', 'coldstorage', 'crosswind', 'cascade']);
  return hashSeed(f.geo + '|' + f.layout + '|' + f.pos.join('|')).toString(16);
}
