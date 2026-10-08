// racesim.mjs: run one race to the end, with nobody watching.
//
// A real course takes about half a second of CPU to race, which would freeze every table on the
// server (page updates, bets, payouts) each time a round opens. So the server hands the work to a
// small pool of worker threads; `simulate` is also what runs when workers are switched off
// (MR_NO_WORKER=1) or fail to start. Same code, same inputs, same answer in either place.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { buildTrack } from '../js/track2d.js';
import { Engine2D, SIM_DT } from '../js/engine2d.js';

const MAX_RACE = 480;     // seconds of race time before the run is cut off

/** The authoritative race: finishing order, times, and every marble's position once a second. */
export function simulate({ courseSeed, raceSeed, blocks }) {
  const track = buildTrack(makeRng(courseSeed), blocks ? { count: blocks } : {});
  const engine = new Engine2D({ track, rng: makeRng(raceSeed), racers: MARBLE_DATA });
  engine.settle();
  const lanes = engine.marbles.map(m => m.lane);
  const sync = [];
  engine.openGate();
  const order = [];
  let guard = Math.ceil(MAX_RACE / SIM_DT);
  while (guard-- > 0 && !engine.allFinished) {
    engine.step(true);
    for (const m of engine.marbles) if (m.finished && !order.includes(m.index)) order.push(m.index);
    if (engine.tick % 240 === 0) sync.push(engine.marbles.map(m => [+m.x.toFixed(3), +m.y.toFixed(3)]));
  }
  const out = engine.marbles.filter(m => m.out).sort((a, b) => b.outTime - a.outTime).map(m => m.index);
  return {
    lanes, sync, layout: track.layout,
    result: {
      finishOrder: order.concat(out),
      eliminated: out,
      times: engine.marbles.map(m => +m.finishTime.toFixed(2)),
      time: +engine.time.toFixed(2),
      nudges: engine.nudges,
    },
  };
}

/* ------------------------------ the worker side ------------------------------ */
if (!isMainThread && parentPort) {
  parentPort.on('message', (job) => {
    try { parentPort.postMessage({ id: job.id, ok: simulate(job) }); }
    catch (e) { parentPort.postMessage({ id: job.id, error: String(e && e.message || e) }); }
  });
}

/* ------------------------------ the server side ------------------------------ */
let pool = null, nextId = 1;
const pending = new Map();

function makePool() {
  const size = Math.max(1, Math.min(3, availableParallelism() - 1));
  const workers = [];
  for (let i = 0; i < size; i++) {
    const w = new Worker(fileURLToPath(import.meta.url));
    w.busy = 0;
    w.on('message', (m) => {
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); w.busy--;
      if (m.error) p.no(new Error(m.error)); else p.ok(m.ok);
    });
    w.on('error', (e) => { console.error('[racesim] worker error:', e.message); });
    w.unref();                                  // an idle pool must not keep the process alive
    workers.push(w);
  }
  return workers;
}

/** Race a round on a worker thread. Falls back to this thread if workers are off or broken. */
export async function race(job) {
  if (process.env.MR_NO_WORKER === '1') return simulate(job);
  try { pool ||= makePool(); } catch (e) { console.error('[racesim] no workers, racing on the main thread:', e.message); return simulate(job); }
  const w = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
  const id = nextId++;
  w.busy++;
  return new Promise((ok, no) => { pending.set(id, { ok, no }); w.postMessage({ ...job, id }); });
}
