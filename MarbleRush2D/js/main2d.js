// main2d.js: Boot, phases, betting, and the render loop for the 2D game.
//
// THE RACE IS DECIDED BEFORE IT IS SHOWN.
//
// As soon as the round opens, betting.js publishes a commitment for the seed.
// This module then runs the WHOLE race headlessly, from that seed, and keeps
// the result. The animation that follows is a second run of the same
// deterministic engine, so it reproduces the stored result step for step, and
// settlement uses the stored result rather than whatever happened to be drawn.
//
// That is the flow the 3D build has never had, it simulated its own race for
// display and settled from that, and it is the whole point of making the
// engine deterministic. Moving it server-side later is then only a question of
// WHERE `precompute()` runs, not of changing how the game works.
//
// If the displayed race ever disagrees with the stored one, that is a
// determinism bug and it is reported loudly rather than hidden.

import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA, MARBLE_DARK } from '../../js/racers.js';
import { BettingManager, fmtAmount, fmtOdds, MIN_BET, RAKE, CURRENCY, PLACE_SHARES } from '../../js/betting.js';
import { buildTrack } from './track2d.js';
import { Engine2D, SIM_DT, TRACK_W, runRace2D, MAX_OUT } from './engine2d.js';
import { Renderer2D } from './render2d.js';
import { detectServer, RemoteBetting } from './net2d.js';
import { sfx } from './sound2d.js';
import { walletProviders, signIn, signOut, walletName, WALLET_LINKS } from './wallet2d.js';

const $ = (id) => document.getElementById(id);

// The marble colours in the HUD come from MARBLE_DATA, the same source the
// canvas draws from, so a row and its marble always match. They replace the
// design's approximate --m-* values in tokens.css (design/HANDOFF.md section 2).
// The token names are the tickers: --m-blz, --m-frs, --m-vnm, --m-roy, --m-bul.
MARBLE_DATA.forEach((d, i) => {
  const root = document.documentElement.style;
  root.setProperty(`--m-${d.ticker.toLowerCase()}`, d.hex);
  root.setProperty(`--m-${d.ticker.toLowerCase()}-dark`, MARBLE_DARK[i]);
});

/** A racer's coin icon for the HUD, matching the coins on the course. */
const coin = (i) =>
  `<span class="coin" style="--c:${MARBLE_DATA[i].hex};--d:${MARBLE_DARK[i]}"></span>`;
const PHASE = { BETTING: 'betting', READY: 'ready', COUNTDOWN: 'countdown', RACING: 'racing', FINISHED: 'finished' };
const STAKES = [10, 25, 50, 100];
/** Text from the network goes into the page through here, never straight into innerHTML. */
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Whole numbers for big stakes, cents for small ones (a 0.5 USDC stake must not read as "1"). */
const fmtA = (v, dp = 0) => fmtAmount(v, Math.abs(v) < 10 && dp === 0 ? 2 : dp);
/** The currency of the round on screen: its token's symbol, or the demo label. */
const cur = () => (betting && betting.currency) || CURRENCY;
// A hard ceiling for a race that has somehow not finished, well clear of the
// ~3.5 minute median and the slowest race measured (5 min 19s).
const MAX_RACE_SECONDS = 480;

/**
 * How long the lobby stays open, in seconds.
 *
 * A hard stop, not a suggestion. When it expires anyone without a bet on the
 * board is staked the minimum on whatever is least backed, everyone still
 * un-readied is readied, and the gates go. One slow table cannot hold up the
 * rest, which matters more here than it looks: the pool is only fair while
 * everybody is betting into the same clock.
 */
const LOBBY_SECONDS = 60;

// Local rounds by default. When the page is served by the round server,
// `betting` is swapped for a live mirror of the server's pool (see net2d.js)
// and every round is the server's: NET is true.
let betting = new BettingManager();
let NET = false;
let netRound = null;          // the server's latest word on the current round
let netStarted = 0;           // the round id whose race replay has started
const mySecond = new Map(), srvSecond = new Map();   // drift checks

let phase = PHASE.BETTING;
let track, engine, renderer, result, raceRng;
let countdown = 0, botTimer = 0, accumulator = 0, settleInfo = null, gridState = null;
let readyIn = [];        // seconds until each other player readies up
let finishedRound = 0;   // the round whose result is on screen
let readyCount = 0;
let cdSeen = 0, finSeen = 0, placedSeen = false;   // what the sounds last reacted to
let lobby = LOBBY_SECONDS;   // seconds left on the lobby clock
let lobbyShown = -1;         // last whole second written to the DOM
let autoNote = '';           // what the clock did on everyone's behalf
let lastOdds = [];           // the tote's previous odds, for the move arrows

/* ------------------------------ round setup ---------------------------- */

// ?only=bowl,sprint pins the course, for looking at one block on the page
// rather than reloading until the random draw offers it.
const ONLY = (new URLSearchParams(location.search).get('only') || '')
  .split(',').filter(Boolean);

/** Build a course and an engine for `seed`. Same seed, same everything. */
function buildFor(seed) {
  const rng = makeRng(seed);
  const t = buildTrack(rng, ONLY.length ? { only: ONLY } : {});
  return { track: t, engine: new Engine2D({ track: t, rng, racers: MARBLE_DATA }), rng };
}

// ?seed=abc replays one exact race. LOCALHOST ONLY: the seed decides the
// winner, so anywhere a real pool exists this would hand it to whoever types it.
const DEV_SEED = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? new URLSearchParams(location.search).get('seed') : null;

function newRound() {
  const seed = betting.newRound(DEV_SEED);

  // The authoritative run. Its own engine, so the displayed one starts clean.
  const pre = buildFor(seed);
  result = runRace2D({ engine: pre.engine, maxSeconds: MAX_RACE_SECONDS });

  // The one we will actually draw. Settle it exactly as the committed run did
  // and keep that state: the betting phase is then free to keep the physics
  // running for the look of it, because the race is restored to this snapshot
  // the instant the gate lifts.
  const show = buildFor(seed);
  track = show.track;
  engine = show.engine;
  raceRng = show.rng;
  engine.settle();
  gridState = engine.snapshot();

  resetRoundUI();
}

/** Everything a new round resets on screen, local or server. */
function resetRoundUI() {
  renderer = new Renderer2D($('board'), engine, MARBLE_DATA);
  renderer.onResize = layoutRail;          // the progress rail follows the course column
  renderer.setCam(camMode);
  ring = []; clips = []; pendingClips = []; liveCut = null; replayT = 0;
  betFail = null; dockLast = ''; tableNote = null;
  if (['waiting', 'cancelled'].includes($('banner').dataset.k)) $('banner').hidden = true;     // a new round: last round's table notice is stale
  resetTower();
  buildCourseMap();
  lastOdds = [];
  $('roundTag').textContent = `Round ${betting.round}`;
  $('ringRnd').textContent = `${NET && betting.tableInfo ? betting.tableInfo.name + ' · ' : ''}Round ${betting.round}`;
  document.body.classList.remove('racing', 'countdown', 'results', 'paid');
  $('ridingChip').hidden = true;
  // The panels must be laid out before the renderer measures around them.
  requestAnimationFrame(() => renderer.resize());
  renderer.resize();
  renderer.camY = 0;

  setRaceLayout(false);
  phase = PHASE.BETTING;
  lobby = LOBBY_SECONDS;
  lobbyShown = -1;
  autoNote = '';
  countdown = 0;
  botTimer = 0.4;
  accumulator = 0;
  settleInfo = null;

  const hash = betting.commitment || '';
  $('commitment').textContent = hash ? `${hash.slice(0, 4)}...${hash.slice(-3)}` : '-';
  $('commitment').title = hash;
  renderFair();
  $('resultOverlay').hidden = true;
  $('countdownOverlay').hidden = true;
  $('phaseLabel').textContent = 'Betting open';
  renderLobby();
  renderTote();
  renderStandings();
  renderWallet();
  renderFeed();
  renderHistory();
}

/* ---------------------------- server rounds ---------------------------- */

/**
 * A round from the server. The COURSE is public, so it is built at once; the
 * grid is drawn from the lanes the server published, at their nominal spots
 * (the exact jitter belongs to the secret race seed). When the gates open the
 * seed arrives and the engine is reset from it, which makes it, bit for bit,
 * the engine the server ran.
 */
function onNetRound(r) {
  if (netRound && netRound.id === r.id && netRound.waiting && !r.waiting) sfx.play('start');      // the first bet started the clock
  netRound = r;
  lobbyShown = -1;                       // the label may change with no change of second (waiting for the first bet -> clock running)
  if (loadingNow) { loadingNow = false; document.body.classList.remove('loading'); renderTote(); renderFeed(); }
  if (!track || r.id !== betting.shownRound) newNetRound(r);
  if (r.phase === 'betting') {
    if (phase !== PHASE.BETTING && phase !== PHASE.READY) phase = PHASE.BETTING;
  } else if (r.phase === 'countdown') {
    if (phase === PHASE.BETTING || phase === PHASE.READY) enterCountdown();
  } else if (r.phase === 'racing' || r.phase === 'results') {
    startNetRace(r);
  }
  renderTote(); renderFeed(); renderWallet(); renderTableChip();
}

function newNetRound(r) {
  betting.shownRound = r.id;
  result = null; settleInfo = null;
  mySecond.clear(); srvSecond.clear();
  track = buildTrack(makeRng(r.courseSeed), r.blocks ? { count: r.blocks } : {});
  engine = new Engine2D({ track, rng: makeRng('display'), racers: MARBLE_DATA });
  const g = track.grid;
  for (const m of engine.marbles) {
    const lane = r.lanes[m.index];
    m.lane = lane;
    m.x = g.x0 + lane * g.dx; m.y = g.y0 - (lane % 2) * g.stagger;
    m.vx = 0; m.vy = 0; m.progress = m.y;
  }
  engine.settle();
  gridState = null;
  raceRng = null;
  resetRoundUI();
  $('nextRace').hidden = true;
}

/** Gates open: reset the engine from the revealed seed and catch up to the server. */
function startNetRace(r) {
  if (netStarted === r.id || !r.raceSeed) return;
  netStarted = r.id;
  engine.reset(makeRng(r.raceSeed));
  engine.settle();
  gridState = engine.snapshot();
  if (phase !== PHASE.COUNTDOWN) { $('countdownOverlay').hidden = true; $('ridingChip').hidden = true; setRaceLayout(true); }
  enterRacing();
  // Joined late, or a slow tab: fast-forward to the server's moment, quietly.
  const behind = Math.floor((betting.now() - r.raceAt) / 1000 / SIM_DT);
  for (let i = 0; i < behind && !engine.allFinished; i++) { engine.step(true); timeLoops(); noteSecond(); }
}

/** Record where everyone is at each whole second, and compare with the server. */
function noteSecond() {
  if (engine.tick % 240) return;
  const s = engine.tick / 240;
  mySecond.set(s, engine.marbles.map(m => [+m.x.toFixed(3), +m.y.toFixed(3)]));
  if (srvSecond.has(s)) checkSecond(s);
}
function onNetSync(d) {
  if (!netRound || d.id !== netRound.id) return;
  srvSecond.set(d.second, d.pos);
  if (mySecond.has(d.second)) checkSecond(d.second);
}
function checkSecond(s) {
  const a = JSON.stringify(mySecond.get(s)), b = JSON.stringify(srvSecond.get(s));
  if (a === b) return;
  // Should never happen: the engine is deterministic. Say so loudly and put
  // the marbles where the server has them.
  console.error(`[race] drifted from the server at ${s}s; snapping back`, { mine: mySecond.get(s), server: srvSecond.get(s) });
  srvSecond.get(s).forEach(([x, y], i) => { engine.marbles[i].x = x; engine.marbles[i].y = y; });
}

function onNetSettled(d) {
  if (netRound && d.id === netRound.id) renderWallet();
}

/* -------------------------------- phases ------------------------------- */

/**
 * Collapse or restore the betting furniture, then RE-MEASURE.
 *
 * The renderer frames the course into whatever the HUD leaves clear, so any
 * change to the HUD has to be followed by a resize or the course keeps using
 * the old safe area. Done on the next frame, after layout has settled.
 */
function setRaceLayout(on) {
  document.body.classList.toggle('race-on', on);
  syncSheets();
  requestAnimationFrame(() => renderer && renderer.resize());
}

/**
 * The player has readied up; now wait for the rest of the table.
 *
 * The other backers ready in a stagger rather than all at once, because a
 * lobby filling up one player at a time reads as other people being there.
 * It is cosmetic and uses plain Math.random, nothing here touches the race,
 * which was already decided from the seed when the round opened.
 */
function enterReady() {
  if (phase !== PHASE.BETTING) return;
  phase = PHASE.READY;
  if (NET) { betting.sendReady(); renderTote(); setRaceLayout(true); $('phaseLabel').textContent = 'Waiting'; return; }
  betting.revealAllBots();
  readyCount = 1;                                   // the player
  readyIn = betting.bots.map(() => 0.15 + Math.random() * 1.5).sort((a, b) => a - b);
  renderTote();
  setRaceLayout(true);
  $('phaseLabel').textContent = 'Waiting';
}

/**
 * The lobby clock has expired.
 *
 * Everyone without a bet on the board takes the fallback, the minimum stake on
 * whatever is least backed, and then the whole table is readied whether or not
 * it pressed READY. The gates go on time.
 *
 * None of this can reach the result. The race was decided from the seed when
 * the round opened and the commitment was published at the same moment; the
 * pool is only the money, and money is allowed to arrive right up to the bell.
 */
function closeLobby() {
  if (NET) return;                     // the server's clock, not ours
  if (phase !== PHASE.BETTING && phase !== PHASE.READY) return;
  lobby = 0;

  // Order matters. The backers who never got their money down go on first, so
  // the player's fallback reads a board that already includes them and the two
  // do not both pile onto the same marble.
  const late = betting.autoBetPending();
  const mine = betting.autoBetPlayer();

  autoNote = mine
    ? `Clock expired. ${fmtA(mine.amount)} ${cur()} auto-staked on ${MARBLE_DATA[mine.marble].name}`
    : betting.placed ? 'Marbles ready'
    : 'Clock expired with no bet down';

  readyCount = betting.bots.length + 1;
  if (late.length) renderFeed();
  renderWallet();
  enterCountdown();
}

function enterCountdown() {
  if (phase !== PHASE.READY && phase !== PHASE.BETTING) return;
  phase = PHASE.COUNTDOWN;
  countdown = 3.0;
  betting.revealAllBots();
  renderTote();
  setRaceLayout(true);
  $('countdownOverlay').hidden = false;
  document.body.classList.add('countdown');
  $('countdownNote').textContent = autoNote || 'Marbles in the gate';
  renderRidingChip();
  // Hand the topbar clock back to the race, or it sits on the last lobby
  // reading right through the countdown.
  $('raceClock').textContent = '0.00s';
  $('phaseLabel').textContent = 'Starting';
  renderLobby();
}

function enterRacing() {
  phase = PHASE.RACING;
  prevVel = null;
  finSeen = 0;
  if (!NET || !netRound || betting.now() - netRound.raceAt < 1500) sfx.play('go');      // not for someone who joins mid-race
  sfx.bed(true);
  accumulator = 0;
  // Start from the committed state, not from wherever the idle physics of the
  // betting phase happened to leave the field. Without this the race on screen
  // is a DIFFERENT race from the one the commitment covers, which is how a
  // pool gets settled on a marble the viewer never saw win.
  if (gridState) engine.restore(gridState);
  engine.openGate();
  $('countdownOverlay').hidden = true;
  $('ridingChip').hidden = true;
  $('banner').hidden = true;
  $('phaseLabel').textContent = 'Racing';
  document.body.classList.remove('countdown');
  document.body.classList.add('racing');
}

function enterFinished() {
  phase = PHASE.FINISHED;
  sfx.bed(false);
  $('phaseLabel').textContent = 'Race over';
  document.body.classList.remove('racing');

  // The full ranking, knockouts included, because that is what the committed
  // run's finishOrder is and what settlement pays on.
  const shown = engine.standings().map(m => m.index);


  // Self-check. The drawn race and the committed race come from one seed
  // through one deterministic engine, so they must agree. If they ever do not,
  // the result is still settled from the COMMITTED run, that is the one the
  // commitment hash covers, but say so loudly, because it means the engine
  // has picked up a non-deterministic input.
  if (shown.join(',') !== result.finishOrder.join(',')) {
    console.error('[race] displayed order disagrees with the committed run.',
                  { shown, committed: result.finishOrder, seed: betting.seed });
  }

  settleInfo = NET ? betting.settle() : betting.settle(result.finishOrder);
  finishedRound = settleInfo.round ?? betting.round;
  showResult();
  renderWallet();
  renderHistory();
}

/* ------------------------------ course map ----------------------------- */

const EVENT_KIND = {
  blackhole: 'ko', jump: 'ko', edge: 'ko', breach: 'ko',
  whitehole: 'warp', greyhole: 'grey', gatehouse: 'gate', mempool: 'pool',
};

/**
 * Rail geometry, set from the renderer's course column. The line sits in the course's off-track margin (left of
 * the wall at WALL_L) and the marble dots hang off its LEFT side, so neither covers the track: on desktop in the
 * lane #railLane keeps clear beside the tower, on a phone in the margin itself.
 */
let cmMarkers = [], cmH = 0, cmLast = '', leadFrac = 0;
const phoneLayout = () => window.matchMedia('(max-width: 900px)').matches;

function layoutRail() {
  const el = $('courseMap');
  if (!el || !renderer || !renderer.safe) return;
  const r = renderer.courseRect(), phone = phoneLayout();
  let top = r.y + 24, bottom = Math.min(r.y + r.h, window.innerHeight) - 40;
  if (document.body.classList.contains('race-on')) {
    // Clear of the camera bar below and, on a phone, the classification strip above (it floats over the course).
    const cam = $('camBar').getBoundingClientRect();
    if (cam.height && cam.top > top) bottom = Math.min(bottom, cam.top - 12);
    if (phone) { const st = $('standingsPanel').getBoundingClientRect(); if (st.height) top = Math.max(top, st.bottom + 16); }
  }
  el.style.left = `${Math.round(r.x + (phone ? 17 : 4))}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.height = `${Math.max(120, Math.round(bottom - top))}px`;
  cmH = el.clientHeight;
  cmLast = '';
}

/** Lay out the progress rail for this round: Gate, the named events, Finish. */
function buildCourseMap() {
  const y0 = track.sections[0].y0, span = track.finishY - y0;
  const marks = [{ f: 0, name: 'Gate' }];
  for (const s of track.sections) if (EVENT_KIND[s.id]) marks.push({ f: ((s.y0 + s.y1) / 2 - y0) / span, name: s.name.replace(/^The /, '') });
  marks.push({ f: 1, name: 'Finish' });
  // A label only where there is room for it: at least 7% of the rail from the last one. Gate and Finish always win.
  let last = -1;
  marks.forEach((m, i) => { m.label = i === 0 || (m.f - last >= 0.07 && m.f < 0.93); if (m.label) last = m.f; });
  marks[marks.length - 1].label = true;
  $('cmMarks').innerHTML = marks.map(m =>
    `<span class="mk${m.label ? ' lb' : ''}" style="top:${(m.f * 100).toFixed(2)}%" title="${esc(m.name)}"><i></i>${m.label ? `<b>${esc(m.name.toUpperCase())}</b>` : ''}</span>`).join('');
  cmMarkers = [...$('cmMarks').children].map((el, i) => ({ el, f: marks[i].f, passed: false, label: marks[i].label }));
  $('cmDots').innerHTML = '';
  cmLast = '';
  leadFrac = 0;
  layoutRail();
}

/** Where a marble is on the course, 0 to 1. */
function courseFrac(m) {
  const y0 = track.sections[0].y0, span = track.finishY - y0;
  return m.finished ? 1 : Math.max(0, Math.min(1, (m.progress - y0) / span));
}

/** Move the rail's fill and its marble chips. A few string compares a frame, a DOM write only on change. */
function renderCourseMap() {
  const live = engine.marbles.filter(m => !m.out).map(m => ({ m, f: courseFrac(m) })).sort((a, b) => b.f - a.f);
  leadFrac = live.length ? live[0].f : leadFrac;
  const pct = Math.round(leadFrac * 100);
  $('cmFill').style.height = `${(leadFrac * 100).toFixed(2)}%`;
  $('towerBar').style.width = `${(leadFrac * 100).toFixed(1)}%`;
  if ($('towerPct').textContent !== `${pct}%`) $('towerPct').textContent = `${pct}%`;
  for (const k of cmMarkers) {
    const passed = k.f <= leadFrac + 1e-6;
    if (passed !== k.passed) { k.passed = passed; k.el.classList.toggle('passed', passed); }
  }
  if (!cmH) return;                                   // hidden (phones) or not laid out yet

  // One numbered dot per marble, left of the line, plus a tick ON the line at its true place. Dots closer than
  // a dot's height are pushed apart (down, then back up from the bottom), so a bunched field reads as a column.
  const mine = betting.placed ? betting.selected : -1, sp = phoneLayout() ? 16 : 22;
  const all = engine.marbles.map(m => ({ m, y: courseFrac(m) * cmH })).sort((a, b) => a.y - b.y || a.m.index - b.m.index);
  all.forEach((d, i) => { d.ry = i ? Math.max(d.y, all[i - 1].ry + sp) : d.y; });
  for (let i = all.length - 1; i >= 0; i--) all[i].ry = Math.min(all[i].ry, i < all.length - 1 ? all[i + 1].ry - sp : cmH);
  const html = all.map(({ m, y, ry }) => {
    const cls = `${m.out ? ' out' : ''}${m.index === mine ? ' mine' : ''}`, c = MARBLE_DATA[m.index].hex;
    return `<i class="tk${cls}" style="top:${Math.round(y)}px;--c:${c}"></i>`
      + `<span class="dt${cls}" style="top:${Math.round(ry)}px;--c:${c}" title="${esc(MARBLE_DATA[m.index].name)}${m.out ? ', out' : ''}">${m.index + 1}</span>`;
  }).join('');
  if (html !== cmLast) { cmLast = html; $('cmDots').innerHTML = html; }
}

/* ----------------------------- race events ----------------------------- */

let bannerTimer = 0;
let tableNote = null;      // the table's notice for the round on screen: { id, kind: 'waiting' | 'cancelled', message }

/** What each hazard DID, for the banner. Keyed by the hazard's cause name. */
const OUT_WORDS = {
  'Black hole': 'swallowed by the black hole',
  'Jump': 'came up short at The Jump',
  'Edge': 'flew off The Edge',
  'Breach': 'went through The Breach and off the track',
};

/**
 * Something happened on the course that a bettor needs to KNOW, not just see.
 *
 * A knockout decides money. It can happen off the main shot while the camera
 * is on the pack, so it is announced in words as well as drawn.
 */
/* ------------------------ knockout cam and replay ----------------------- */

// The last few seconds of the race, every frame, so a knockout can be shown
// again. A clip is taken 1.2s AFTER the knockout (so it includes the fall),
// reaching back 3.5s before it.
const RING_TICKS = 6 * 240;
let ring = [], clips = [], pendingClips = [], liveCut = null, replayT = 0;

function recordFrame() {
  ring.push({ tick: engine.tick, outCount: engine.outCount,
    marbles: engine.marbles.map(m => ({ index: m.index, data: m.data, x: m.x, y: m.y, r: m.r, out: m.out,
      outX: m.outX, outY: m.outY, outBy: m.outBy, frozen: m.frozen, frozenBy: m.frozenBy, held: m.held, finished: m.finished, spin: 0 })) });
  while (ring.length && ring[0].tick < engine.tick - RING_TICKS) ring.shift();
  for (let i = pendingClips.length - 1; i >= 0; i--) {
    const p = pendingClips[i];
    if (engine.tick < p.until) continue;
    clips.push({ ...p, frames: ring.filter(f => f.tick >= p.tickOut - 3.5 * 240) });
    pendingClips.splice(i, 1);
  }
}

/** The side cam: live knockout cut, else the leader. */
function drawSideCam() {
  const cam = $('leaderCam');
  if (!cam || !cam.clientWidth) return;
  const panel = cam.closest('.cam');
  if (liveCut && liveCut.until > performance.now()) {
    const m = engine.marbles[liveCut.index];
    renderer.drawInset(cam, m.out ? { x: m.outX, y: m.outY } : m);
    $('camName').textContent = `LIVE · ${MARBLE_DATA[liveCut.index].name} out`;
    panel?.classList.add('live');
    return;
  }
  panel?.classList.remove('live');
  const lead = engine.standings()[0];
  renderer.drawInset(cam, lead);
  $('camName').textContent = lead ? MARBLE_DATA[lead.index].name : '-';
}

/** Play the knockout clips on the result card, slow motion, round and round. */
function drawReplay(dt) {
  const box = $('koReplay');
  if (!clips.length || $('resultOverlay').hidden) { box.hidden = true; $('koPull').hidden = true; return; }
  box.hidden = false;
  if ($('koPull').hidden) $('koPull').hidden = false;
  replayT += dt * 0.5;                                   // half speed
  const lens = clips.map(c => c.frames.length / 60 + 0.8);
  const total = lens.reduce((a, b) => a + b, 0);
  let t = replayT % total, k = 0;
  while (t > lens[k]) { t -= lens[k]; k++; }
  const c = clips[k];
  const f = c.frames[Math.min(c.frames.length - 1, Math.floor(t * 60))];
  const outAt = c.frames.findIndex(x => x.marbles[c.index].out);
  const since = outAt >= 0 ? (Math.floor(t * 60) - outAt) / 60 : -1;
  const m = f.marbles[c.index];
  const gone = since >= 0 ? [{ index: c.index, x: m.outX, y: m.outY, hx: m.outX, hy: m.outY, t: since }] : [];
  renderer.drawReplay($('koCanvas'), f, c.index, gone);
  $('koLabel').textContent = `${MARBLE_DATA[c.index].name} · ${c.cause}${clips.length > 1 ? `  (${k + 1}/${clips.length})` : ''}`;
}

/* ------------------------------- cameras ------------------------------- */

function buildCamBar() {
  $('camCoins').innerHTML = MARBLE_DATA.map((d, i) =>
    `<button data-cam="${i}" aria-label="Follow ${d.name}, marble ${i + 1}" title="Follow ${d.name}"><span class="tok" style="--c:${d.hex}">${i + 1}</span></button>`).join('');
  for (const b of document.querySelectorAll('#camBar button')) {
    b.onclick = () => {
      if (b.classList.contains('out')) return;              // nothing left to follow
      const v = b.dataset.cam;
      setCam(/^\d$/.test(v) ? +v : v);
    };
  }
  setCam(camMode);
}
/** One place that changes the camera, so the bar, the My marble card and the renderer agree. */
function setCam(mode) {
  camMode = mode;
  if (renderer) renderer.setCam(mode);
  for (const b of document.querySelectorAll('#camBar button')) {
    const on = b.dataset.cam === String(mode);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  }
  myLast = '';
}
let camMode = 'auto';

/**
 * Pinball sounds from the race, read AFTER each engine tick and never fed back: a bumper the engine says was struck rings its own
 * note, and any other sharp change in a marble's velocity (beyond gravity's pull) is a knock on a wall, flipper, spinner or marble.
 */
let prevVel = null;
const KNOCK = 120, KNOCK_FULL = 700;       // px/s of velocity change: where a knock starts to sound, and where it is at full strength
function soundImpacts() {
  const E = engine, M = E.marbles;
  if (!sfx.ready) { prevVel = null; return; }
  const mine = betting.placed ? betting.selected : -1;
  const near = new Set();                                           // marbles that already rang a bumper this tick
  for (const bi of E.hits) {
    const b = E.track.bumpers[bi];
    let best = -1, bd = 1e9;
    for (let i = 0; i < M.length; i++) { const d = (M[i].x - b.x) ** 2 + (M[i].y - b.y) ** 2; if (d < bd) { bd = d; best = i; } }
    if (best >= 0) near.add(best);
    sfx.bumper(bi, b.rest > 1, ((b.x / TRACK_W) - 0.5) * 1.2, best === mine ? 1.4 : 0.8);
  }
  const g = 1500 * SIM_DT;                                          // what gravity alone adds in one tick
  if (!prevVel || prevVel.length !== M.length) prevVel = M.map(m => [m.vx, m.vy]);
  for (let i = 0; i < M.length; i++) {
    const m = M[i], pv = prevVel[i];
    const dv = Math.sqrt((m.vx - pv[0]) ** 2 + (m.vy - pv[1] - g) ** 2);
    pv[0] = m.vx; pv[1] = m.vy;
    if (dv < KNOCK || m.finished || m.out || near.has(i)) continue;
    let other = false;                                              // another marble touching: glass on glass
    for (let j = 0; j < M.length; j++) if (j !== i && !M[j].out && (M[j].x - m.x) ** 2 + (M[j].y - m.y) ** 2 < (m.r + M[j].r + 2) ** 2) { other = true; break; }
    sfx.impact(Math.min(1, (dv - KNOCK) / (KNOCK_FULL - KNOCK)), ((m.x / TRACK_W) - 0.5) * 1.2, other, i === mine ? 1.4 : 0.8);
  }
}

const SFX_EVENT = { out: 'ko', freeze: 'freeze', brake: 'brake', grab: 'grab', reorg: 'reorg' };
function onRaceEvent(ev) {
  renderer.noteEvent(ev);
  if (ev.type === 'warp') sfx.play(ev.dir > 0 ? 'warpUp' : 'warpDown');
  else if (ev.type === 'load' && ev.kind === 'rocket') sfx.play('launch');
  else if (SFX_EVENT[ev.type]) sfx.play(SFX_EVENT[ev.type]);
  if (ev.type === 'out') {
    pendingClips.push({ index: ev.index, cause: OUT_WORDS[ev.cause] || ev.cause, tickOut: engine.tick, until: engine.tick + Math.round(1.2 * 240) });
    renderFinalPool();
    liveCut = { index: ev.index, until: performance.now() + 3000 };
  }
  if (ev.type === 'warp') {
    renderer.onWarp(ev);
    flags[ev.index].warp = performance.now() + 2000;
    const d = MARBLE_DATA[ev.index];
    const n = Math.abs(ev.secs);
    announce(
      `${coin(MARBLE_DATA.indexOf(d))}` +
      `<span class="msg"><b>${d.name}</b> ` + (ev.dir > 0
        ? `aped into the ${ev.kind} hole, about ${n}s <b class="up">ahead</b>`
        : `got rugged by the grey hole, about ${n}s <b class="down">back</b>`) +
      `</span>`,
      ev.dir > 0 ? 'warp' : 'back');
    return;
  }
  // The crypto machines, announced in the house voice.
  const say = {
    freeze: (ev) => [`funds <b class="down">frozen</b> for ${ev.secs}s (compliance review)`, 'back'],
    brake: () => [`paid the <b class="down">gas fee</b> at the speed camera`, 'back'],
    grab: (ev) => [ev.diamond ? `💎 diamond hands, held ${ev.secs}s` : `🧻 paper hands, let go after ${ev.secs}s`, 'back'],
    reorg: () => [`<b class="down">reorged</b>, sent back a block`, 'back'],
    load: (ev) => ev.kind === 'bridge' ? [`bridging chains, ${ev.secs}s to confirm`, 'bridge']
      : ev.kind === 'vault' ? [`staked in the vault, paying out in ${ev.secs}s`, 'stake']
      : ev.kind === 'rocket' ? [`🚀 on the launchpad, T-${ev.secs}s`, 'launch'] : null,
  };
  if (say[ev.type]) {
    const r = say[ev.type](ev);
    if (!r) return;
    announce(`${coin(ev.index)}<span class="msg"><b>${MARBLE_DATA[ev.index].name}</b> ${r[0]}</span>`, r[1]);
    return;
  }
  if (ev.type !== 'out') return;
  const d = MARBLE_DATA[ev.index];
  const last = engine.outCount >= MAX_OUT;
  announce(
    `${coin(MARBLE_DATA.indexOf(d))}` +
    `<span class="msg"><b class="down">REKT.</b> <b>${d.name}</b> ${OUT_WORDS[ev.cause] || 'is out'}</span>` +
    (last ? `<small>Hazards now disarmed</small>` : ''),
    'out');
}

const BANNER_WORD = { out: 'KNOCKOUT', warp: 'WARP', back: 'INCIDENT', bridge: 'BRIDGE', stake: 'STAKED', launch: 'LAUNCH' };
function announce(html, kind = '', secs = 3.2) {
  const el = $('banner');
  el.className = `banner ${kind}`;
  el.dataset.k = ''; el.style.top = '';
  // RACE CONTROL | KNOCKOUT · Royal swallowed
  el.innerHTML = (BANNER_WORD[kind] ? `<span class="bk">${BANNER_WORD[kind]}</span><span class="sep">·</span>` : '') + html;
  el.hidden = false;
  // Restart the entrance animation even when one banner replaces another.
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  bannerTimer = secs;
}

/* --------------------------------- UI ---------------------------------- */

/** m:ss, for anything counting down rather than up. */
function fmtClock(secs) {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The ring's circumference (r = 80 in index.html). */
const RING_C = 2 * Math.PI * 80;
let lobbyClosed = false;     // bets were closed at the last renderLobby (so the market re-renders once as they close)
/** Seconds the betting window lasts: the server's own figure on a server round (it can differ from the local 30). */
/** True while this table holds its round for a connected wallet (guests watch a still table). */
const waitingForPlayer = () => !!(NET && netRound && netRound.waiting && !netRound.needBet && netRound.table && netRound.table.startOn === 'player');
const lobbyTotal = () => (NET && netRound && netRound.closesAt > netRound.opensAt ? (netRound.closesAt - netRound.opensAt) / 1000 : LOBBY_SECONDS);

/**
 * The lobby clock: the ring on the betting screen, and the same countdown in the topbar (the phone's copy).
 *
 * Called every frame, so it writes text only when the displayed SECOND changes. The ring's arc is a
 * stroke-dashoffset, the one thing here that updates smoothly every frame.
 */
function renderLobby() {
  const box = $('lobby');
  const live = phase === PHASE.BETTING || phase === PHASE.READY;
  const left = live ? Math.max(0, lobby) : 0;

  $('lobbyFill').style.strokeDashoffset = (RING_C * (1 - Math.min(1, left / lobbyTotal()))).toFixed(1);
  box.classList.toggle('soon', live && left <= 10);
  box.classList.toggle('now', live && left <= 5);

  // Lock the market the moment bets close (4 s before zero on a server round), not on the next whole second.
  const closed = live && betsClosed();
  if (closed !== lobbyClosed) { lobbyClosed = closed; if (closed && phase === PHASE.BETTING && renderer) renderTote(); }

  const secs = Math.ceil(left);
  if (!live || secs === lobbyShown) return;
  lobbyShown = secs;

  $('lobbyClock').textContent = fmtClock(left);
  $('lobbyLabel').textContent = phase === PHASE.READY ? 'Gates open' : tableNote && tableNote.kind === 'cancelled' ? 'Cancelled' : left <= 0 ? 'Closed' : netRound && netRound.waiting ? 'Waiting' : 'Betting';
  // The topbar clock counts race seconds once there is a race. Until then it carries the same
  // countdown: on a phone the ring is not drawn and this is the copy you can see.
  $('raceClock').textContent = fmtClock(left);
}

function renderWallet() {
  const el = $('balance');
  el.textContent = '';
  if (betting.guest) el.textContent = '-';
  else {
    el.append(fmtAmount(betting.balance) + ' ');
    const c = document.createElement('small');
    c.className = 'cur'; c.textContent = cur();
    el.append(c);
  }
  // Low balance (under the minimum bet): a LOW text tag, plus a dot on the avatar. Never the dot alone.
  const low = !betting.guest && betting.balance < (betting.minBet ?? MIN_BET) - 1e-9;
  $('lowTag').hidden = !low;
  const chip = $('walletBtn');
  chip.classList.toggle('low', low);
  if (!betting.guest) chip.setAttribute('aria-label', `Wallet ${shortAddr(betting.address)}${low ? ', low balance' : ''}`);
  renderRecord();
}

/** "FRS 02": a marble's ticker and number, so a row never relies on colour alone. */
const mtag = (i) => `${MARBLE_DATA[i].ticker} ${String(i + 1).padStart(2, '0')}`;

/** A stake that is the house's, not a player's (server rounds only: the server marks players with `human`). */
const isHouse = (b) => NET && !b.human && !b.mine;

/** Live bets: who backed what, most recent first. */
function renderFeed() {
  const ul = $('feed');
  if (!ul) return;
  if (loadingNow) { skeletonRows(ul, 3); $('feedCount').textContent = 'Loading'; return; }
  const rows = betting.bots.slice(-4).reverse();
  $('feedCount').textContent = betting.bots.length ? `${betting.bots.length}` : '';
  const lastBet = betting.bots[betting.bots.length - 1], pk = $('betPeek');
  if (lastBet) {
    const d = MARBLE_DATA[lastBet.marble];
    pk.innerHTML = `<i class="pulse" aria-hidden="true"></i><span class="stripe" style="--c:${d.hex}"></span><b>${esc(lastBet.handle)}</b>` +
      `<span class="what">${esc(d.name)} · ${fmtA(lastBet.amount)}</span>${lastBet.whale ? '<em class="whale">WHALE</em>' : ''}${isHouse(lastBet) ? '<em class="house">HOUSE</em>' : ''}<span class="more">FEED ↑</span>`;
  } else pk.innerHTML = `<i class="pulse" aria-hidden="true"></i><span class="what">${waitingForPlayer() ? 'Connect a wallet to start the round' : 'No bets yet · Be the first'}</span><span class="more">FEED ↑</span>`;
  ul.innerHTML = rows.map(b => {
    const d = MARBLE_DATA[b.marble];
    return `<li class="${b.mine ? 'mine' : ''}" style="--c:${d.hex}"><span class="stripe"></span>` +
      `<span class="who"><b>${esc(b.handle)}${b.auto ? ' · auto' : ''}</b><span>backed ${esc(d.name)} · ${mtag(b.marble)}</span></span>` +
      `${b.whale ? '<em class="whale">WHALE</em>' : ''}${isHouse(b) ? '<em class="house" title="A stake from the house, not a player">HOUSE</em>' : ''}` +
      `<span class="amt">${fmtA(b.amount)} <small>${esc(cur())}</small></span></li>`;
  }).join('') || `<li class="empty"><b>${waitingForPlayer() ? 'Waiting for a player' : 'No bets yet · Be the first'}</b><span>${waitingForPlayer() ? 'The round starts when a wallet joins this table' : 'Bets appear here as they land'}</span></li>`;
}

function renderRecord() {
  const dl = $('record');
  if (!dl) return;
  const s = betting.stats;
  const net = betting.netProfit;
  dl.innerHTML =
    `<dt>Races</dt><dd>${s.races}</dd>` +
    `<dt>Wins</dt><dd>${s.wins}</dd>` +
    `<dt>Strike rate</dt><dd>${(betting.winRate * 100).toFixed(0)}%</dd>` +
    `<dt>Net</dt><dd class="${net >= 0 ? 'good' : 'bad'}">` +
    `${net >= 0 ? '+' : '−'}${fmtAmount(Math.abs(net))}</dd>` +
    `<dt>Streak</dt><dd>${s.streak}</dd>`;
}

/**
 * Recent winners.
 *
 * A row has to say three things or it is just a row of coloured dots: WHICH
 * marble won, WHICH race it was, and what the round did to your wallet. The
 * last one is signed off the PROFIT rather than the finishing position, because
 * a marble that places while carrying most of the pool can still pay back less
 * than its stake, and "2nd" on its own would read as a win.
 */
function renderHistory() {
  const ul = $('history');
  if (!ul) return;
  const ORD = ['1st', '2nd', '3rd', '4th', '5th'];

  ul.innerHTML = betting.history.slice(0, 6).map(h => {
    const d = MARBLE_DATA[h.winner];
    let tag = 'No bet', cls = 'none';

    if (h.void) {
      tag = 'Void'; cls = 'none';
    } else if (h.stake > 0) {
      const profit = h.payout - h.stake;
      const up = profit >= 0;
      if (h.place >= 0) {
        tag = `${ORD[h.place]} ${up ? '+' : '−'}${fmtA(Math.abs(profit))}`;
        cls = up ? 'win' : 'lose';
      } else {
        tag = `−${fmtA(h.stake)}`;
        cls = 'lose';
      }
    }

    return `<li>${coin(h.winner)}` +
           `<span class="who"><b>${d.name}</b> <i>race ${h.round}</i></span>` +
           `<span class="amt ${cls}">${tag}</span></li>`;
  }).join('') ||
    '<li class="empty"><span class="who"><b>No races yet</b> <i>Your first race result will show here</i></span></li>';
}

/** A bet is in flight from the press of Bet until the wallet and the chain have answered (R1). */
const inflight = () => !!betting.betState && betting.betState !== 'idle';
/** Nothing about the bet may change: it is sent or on its way, the clock ran out, or the race has begun (R1). */
/* ------------------------- system states (frames A1 to A5) ------------------------- */

let connLost = false, everLive = false, loadingNow = false, connTimers = [];
/** The server round was meant to be sealed on Solana and that failed: nobody can bet on it. */
const chainDown = () => { const c = NET ? betting.chain : null; return !!(c && c.cluster && c.commit.status === 'failed'); };
/** Seconds before the gates open when a server round stops taking bets: the server refuses a prepare inside its last
 *  4 s (a bet needs time to be signed and confirmed), so the dock closes a little before that instead of failing. */
const BET_CUTOFF = 4.25;
const betsClosed = () => lobby <= (NET ? BET_CUTOFF : 0);
const isLocked = () => phase !== PHASE.BETTING || !!betting.placed || inflight() || betsClosed() || connLost || chainDown();
let betFail = null;          // why the last bet was not placed (A11a); cleared by any change of pick or stake
let dockLast = '';           // the dock is only written when its content changes

function pickMarble(i) {
  if (isLocked()) return;
  betFail = null;
  betting.select(i);
  sfx.play('pick');
  renderTote();
}

function renderTote() {
  const ul = $('tote');
  if (loadingNow) { skeletonRows(ul, MARBLE_DATA.length); ul.setAttribute('aria-busy', 'true'); return; }
  ul.removeAttribute('aria-busy');
  const locked = isLocked();
  // Rebuilding the rows would drop keyboard focus, so remember which row had it.
  const focused = ul.contains(document.activeElement) ? [...ul.children].indexOf(document.activeElement.closest('li')) : -1;
  ul.innerHTML = '';

  const total = betting.totalPool;
  MARBLE_DATA.forEach((d, i) => {
    const li = document.createElement('li');
    const sel = betting.selected === i;
    li.className = (sel ? 'sel ' : '') + (locked ? 'locked' : '');
    li.style.setProperty('--c', d.hex);
    const on = betting.pools[i];
    const o = on > 0 ? betting.oddsFor(i, 0) : null;
    const odds = o !== null ? fmtOdds(o) : null;
    const pl = on > 0 ? fmtOdds(betting.oddsFor(i, 1)) : null;
    // Which way the price moved since the board last drew, like a ticker.
    // Longer odds (more of the pool per unit staked here) show as UP.
    const prev = lastOdds[i];
    const move = o === null || prev === undefined || prev === null || Math.abs(o - prev) < 1e-9 ? ''
               : o > prev ? 'up' : 'down';
    lastOdds[i] = o;
    const share = total > 0 ? (on / total) * 100 : 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-pressed', sel);
    li.setAttribute('aria-label', `${d.name}, ${mtag(i)}, ${odds ? `wins pay ${odds}` : 'no bets yet'}${sel ? ', selected' : ''}${locked ? ', locked' : ''}`);
    if (locked) li.setAttribute('aria-disabled', 'true'); else li.tabIndex = 0;
    li.innerHTML =
      `<span class="who"><span class="stripe"></span><b class="n">${i + 1}</b>` +
      `<span class="id"><span class="nm">${esc(d.name)}</span><span class="tk">${d.ticker}</span>` +
      `<span class="more">${on > 0 ? `2nd ${pl || '-'} · ${betting.backers[i]} ${betting.backers[i] === 1 ? 'backer' : 'backers'}` : 'No bets yet'}</span></span></span>` +
      `<span class="win ${odds ? move : 'none'}${odds && odds.length > 5 ? ' long' : ''}">${odds || '-'}` +
      `${move ? `<span class="arrow" aria-hidden="true">${move === 'up' ? '▲' : '▼'}</span>` : ''}</span>` +
      `<span class="pl">${pl || '-'}</span>` +
      `<span class="sh"><span>${on > 0 ? `${share.toFixed(0)}%` : '-'}</span><span class="bar"><i style="width:${share.toFixed(1)}%"></i></span></span>` +
      `<span class="bk">${on > 0 ? betting.backers[i] : '-'}</span>`;
    if (!locked) {
      li.onclick = () => pickMarble(i);
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickMarble(i); } };
    }
    ul.appendChild(li);
  });
  if (focused >= 0 && ul.children[focused] && ul.children[focused].tabIndex === 0) ul.children[focused].focus({ preventScroll: true });

  $('poolTotal').textContent = fmtAmount(betting.totalPool);
  $('poolCur').textContent = cur();
  renderFinalPool();
  $('rakePct').textContent = `${(RAKE * 100).toFixed(0)}%`;
  $('places').textContent = `${PLACE_SHARES.length} places paid · ${PLACE_SHARES.map(x => Math.round(x * 100)).join(' / ')}`;
  const minB = betting.minBet ?? MIN_BET;
  $('mkShort').textContent = `${PLACE_SHARES.map(x => Math.round(x * 100)).join('/')} · MIN ${Number.isInteger(minB) ? minB : fmtAmount(minB)}`;
  renderStakes();
  renderBetButton();
}

/** The four stake chips. Always drawn, so the dock never changes height; locked states keep the pick readable. */
function renderStakes() {
  const box = $('stakes');
  const list = betting.stakes || STAKES;
  const lock = isLocked() || !!betting.guest;
  box.style.setProperty('--n', list.length);
  $('slip').classList.toggle('stack', list.length > 4);
  box.classList.toggle('lock', lock);
  box.innerHTML = '';
  for (const v of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = v;
    b.setAttribute('aria-pressed', betting.stake === v);
    if (betting.stake === v) b.className = 'on';
    b.disabled = lock || !betting.canAfford(v);
    b.onclick = () => { if (isLocked()) return; betFail = null; betting.setStake(v); renderTote(); };
    box.appendChild(b);
  }
}

/** A1: the link dropped. The race keeps running here (this screen simulates it); data panels hold their last update. */
function showConn(kind) {
  const b = $('connBanner');
  b.hidden = !kind;
  b.dataset.k = kind || '';
  if (kind === 'lost') b.innerHTML = `<i class="spin" aria-hidden="true"></i><span>Reconnecting… <span class="sub">the race keeps running here</span></span><em class="wtag2">PAUSED</em>`;
  else if (kind === 'back') b.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>Reconnected</span><em class="wtag2">LIVE</em>`;
}
function offlineCard() {
  const c = $('offlineCard');
  c.innerHTML = GRAB + `<div class="wstate"><span class="wbang" aria-hidden="true">!</span><b class="wtag">OFFLINE</b>` +
    `<h2 class="wtitle" id="offlineTitle">Can't reach the server</h2>` +
    `<p class="wnote">Your balance is on Solana. We'll keep trying in the background.</p></div>` +
    `<button type="button" class="wbtn" id="offlineRetry">Retry</button>`;
  c.setAttribute('role', 'alertdialog'); c.setAttribute('aria-modal', 'true'); c.setAttribute('aria-labelledby', 'offlineTitle');
  $('offlineRetry').onclick = () => location.reload();
  $('offlineOverlay').hidden = false;
}
function onNetStatus(st) {
  if (st === 'reconnecting') {
    if (connLost) return;
    connLost = true;
    document.body.classList.add('reconnecting');
    for (const t of connTimers) clearTimeout(t);
    connTimers = [setTimeout(() => { if (connLost) offlineCard(); }, 12000)];   // A4: a few seconds is a blip, this is an outage
    showConn('lost'); renderTote(); renderBetButton();
  } else if (st === 'live') {
    everLive = true;
    if (!connLost) return;
    connLost = false;
    for (const t of connTimers) clearTimeout(t);
    document.body.classList.remove('reconnecting');
    $('offlineOverlay').hidden = true;
    showConn('back');
    connTimers = [setTimeout(() => { if (!connLost) showConn(null); }, 2000)];
    renderTote(); renderBetButton();
  }
}

/** A2: until the first round arrives, rows keep their real 40px height so nothing jumps. */
function skeletonRows(ul, n) { ul.innerHTML = Array.from({ length: n }, () => '<li class="skel" aria-hidden="true"><i></i><i></i></li>').join(''); }

const shortHash = (h) => (h ? `${h.slice(0, 4)}...${h.slice(-3)}` : '-');

/** The proof pill (top bar) and the proof card (left column) say how far the round has got on Solana. */
function renderFair() {
  const el = document.querySelector('.fair'), label = $('fairLabel');
  if (!el || !label) return;
  const c = NET ? betting.chain : null;
  let text = 'Provably fair', sig = null, sealing = false, state = 'fixed';
  if (c && c.cluster) {
    if (c.reveal.status === 'confirmed') { text = 'Verified on Solana'; sig = c.reveal.sig; state = 'verified'; }
    else if (c.commit.status === 'confirmed') { text = 'Sealed on Solana'; sig = c.commit.sig; state = 'sealed'; }
    else if (c.commit.status === 'pending') { text = 'Sealing on Solana…'; sealing = true; state = 'sealing'; }
    else { text = 'Not sealed on Solana'; state = 'none'; }
  }
  label.textContent = text;
  el.classList.toggle('sealing', sealing);
  el.classList.toggle('none', state === 'none');
  el.classList.add('link');
  el.setAttribute('aria-disabled', 'false');
  const open = openProof;                                 // the pill opens the proof card; it links to both transactions
  el.onclick = open;
  el.title = 'Open this round\'s proof';
  // The phone's copy of the pill, under the betting ring (the top bar's shield steps aside there).
  const mf = $('mFair');
  $('mFairLabel').textContent = text;
  $('mFairHash').textContent = $('commitment').textContent;
  mf.classList.toggle('sealing', sealing);
  mf.classList.toggle('none', state === 'none');
  mf.classList.add('link');
  mf.setAttribute('aria-disabled', 'false');
  mf.onclick = open;
  mf.title = el.title;

  // The left column's proof card. The copy only claims Solana when Solana has the commitment.
  $('proofState').textContent = text;
  $('proofHash').textContent = $('commitment').textContent;
  $('proofPill').classList.toggle('sealing', sealing);
  $('proofPill').classList.toggle('none', state === 'none');
  const n = betting.round;
  $('proofText').textContent = {
    verified: `Round ${n} was sealed on Solana before betting opened, and its seed is now revealed, so anyone can replay the race.`,
    sealed: `Round ${n} was sealed on Solana before betting opened. The seed is revealed when the gates open, so anyone can check the result.`,
    sealing: `Round ${n} is being sealed on Solana. Betting opens as soon as it is sealed.`,
    fixed: `Round ${n} is fixed by this hash before betting opens. The seed is revealed when the gates open, so anyone can replay the race.`,
    none: `Round ${n} cannot be verified on-chain. It was not sealed before betting, so it runs as a watch-only race.`,
  }[state];
  const v = $('proofVerify');
  v.onclick = open;
  // The same facts on the result screen's proof bar (S9 turns the button into the proof card).
  $('resProofText').textContent = text;
  $('resProofHash').textContent = $('commitment').textContent;
  $('resProof').classList.toggle('sealing', sealing);
  $('resProof').classList.toggle('none', state === 'none');
  $('resProofBtn').onclick = open;
  if (!$('proofOverlay').hidden) renderProof();           // a chain event while the card is open
}

/* ------------------------------- the bet dock ------------------------------- */

const ICON = {
  spin: '<svg class="spin" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="2.5"/><path d="M12 3a9 9 0 0 1 9 9" stroke-width="2.5"/></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style="stroke-width:2.5"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  wallet: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12.5h2M3 9h13a2 2 0 0 0 2-2V5"/></svg>',
  drop: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c3.5 4.5 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 2.5-6.5 6-11z"/></svg>',
  lock: '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};

/** The three-step bar of A03 to A05: Prepare, Approve, Confirm. */
function stepsHtml(n) {
  return ['Prepare', 'Approve', 'Confirm'].map((t, k) => {
    const done = k < n - 1, cur = k === n - 1;
    return `<div class="st${done ? ' done' : ''}${cur ? ' cur' : ''}"><span class="bar">${cur ? `<i${n === 3 ? ' class="ind"' : ''}></i>` : ''}</span><span class="t">${done ? '✓ ' : ''}${k + 1} ${t}</span></div>`;
  }).join('');
}

const pressBet = () => { if (isLocked()) { renderTote(); return; } betFail = null; if (betting.placeBet()) { renderTote(); renderWallet(); } };
const topUp = () => { betting.topUp(); renderWallet(); renderTote(); };

/**
 * What the dock shows now: the CTA ladder A01 to A11a (design/HANDOFF.md section 4). One place decides it, so
 * the label, the status row, the hint and the lock can never disagree. First match wins.
 */
function dockView() {
  const min = betting.minBet ?? MIN_BET, sel = betting.selected;
  const name = sel >= 0 ? MARBLE_DATA[sel].name : '';
  const minTxt = Number.isInteger(min) ? String(min) : fmtAmount(min);
  const v = { head: 'stake', stakeLbl: `Stake · min ${minTxt}`,
    forTxt: sel >= 0 ? `Backing <b>${esc(name)}</b> · ${mtag(sel)}` : 'No marble selected', disabled: true };

  // A09: the clock ran out, or the race has begun. A bet already placed stands. (A bet still in flight is shown below.)
  if (tableNote && tableNote.kind === 'cancelled' && tableNote.id === betting.round) {
    return { ...v, k: 'idle', forTxt: 'Round cancelled', label: `${ICON.lock}Round cancelled`, hint: esc(tableNote.message) };
  }
  if (phase !== PHASE.BETTING || (betsClosed() && !inflight())) {
    return { ...v, k: 'idle', forTxt: 'Bets locked', label: `${ICON.lock}Betting closed`,
      hint: betting.placed ? `Your bet on ${esc(name)} stands · ${fmtA(betting.stake)} ${esc(cur())}`
        : lobby > 0 ? 'Bets close 4 seconds before the gates open' : 'You are watching this round' };
  }
  if (connLost) {                                                                                       // A1: bets pause with the link
    return { ...v, k: 'idle', forTxt: 'Link lost', label: `${ICON.spin}Reconnecting…`, hint: 'Bets resume when the link is back' };
  }
  if (chainDown()) {                                                                                    // A5
    return { ...v, k: 'idle', forTxt: 'Watching only', label: `${ICON.lock}Chain unavailable · watching only`, hint: 'This round cannot be verified on-chain.' };
  }
  if (betting.guest) {                                                                                  // A08
    return { ...v, k: 'cta', disabled: false, onclick: openWallet, label: `${ICON.wallet}Connect wallet to play`, hint: 'Players never need SOL' };
  }
  if (betting.sealing) {                                                                                // A10
    const h = ($('commitment').title || '').slice(0, 4);
    return { ...v, k: 'idle', forTxt: `Round ${betting.round}`, label: `${ICON.spin}Sealing round on Solana…`,
      hint: `<span class="sealpill">${ICON.spin.replace('width="20" height="20"', 'width="14" height="14"')}<b>Sealing</b>${h ? `<code>${esc(h)}...</code>` : ''}</span><span>Betting opens when sealed</span>` };
  }
  if (inflight()) {                                                                                     // A03, A04, A05
    const n = { preparing: 1, signing: 2, confirming: 3 }[betting.betState] || 1, wn = walletName();
    return { ...v, k: 'busy', head: 'steps', steps: n,
      label: n === 1 ? `${ICON.spin}Preparing your bet`
        : n === 2 ? `${wn === 'your wallet' ? ICON.wallet : `<span class="glyph" aria-hidden="true">${esc(wn[0])}</span>`}Approve in ${esc(wn)}`
        : `${ICON.spin}Confirming on Solana`,
      hint: n === 1 ? 'Building the token transfer'
        : n === 2 ? `<span>${wn === 'your wallet' ? 'Check your wallet' : `Check the ${esc(wn)} window`}</span><span class="dot">·</span><button type="button" class="linkbtn" id="betCancel">Cancel</button>`
        : 'Usually under 2 seconds' };
  }
  if (betting.placed) {                                                                                 // A06: final, nothing to press
    return { ...v, k: 'done', label: `${ICON.check}Bet placed`,
      hint: `Locked once sent · ${fmtA(betting.stake)} ${esc(cur())} on ${esc(name)}` + quorumNote(' · ') };
  }
  if (betFail) {                                                                                        // A11a
    return { ...v, k: 'retry', disabled: false, onclick: pressBet, head: 'notice', notice: { tag: 'NOT PLACED', msg: betFail },
      label: 'Bet not placed · Try again', hint: 'Your stake and pick are kept' };
  }
  if (betting.balance < min - 1e-9) {                                                                   // A07
    const low = betting.balance === 0
      ? `<span class="tagbox">NEW WALLET</span><span>Free devnet test tokens. No real funds.</span>`        // A3
      : `<span class="tagbox">LOW</span><span>Balance ${fmtAmount(betting.balance)} ${esc(cur())}, minimum ${minTxt}</span>`;
    return betting.token
      ? { ...v, k: 'cta', disabled: false, onclick: openWallet, label: `${ICON.drop}Get test token`, hint: low }
      : { ...v, k: 'cta', disabled: false, onclick: topUp, label: `${ICON.drop}Top up demo wallet`, hint: low };
  }
  if (sel < 0) return { ...v, k: 'idle', label: 'Pick a marble', hint: 'Tap a marble row to back it' };    // A01
  if (!betting.canAfford(betting.stake)) return { ...v, k: 'idle', label: 'Stake too high', hint: 'Choose a smaller stake' };
  const q = betting.quote(sel, betting.stake);                                                           // A02
  return { ...v, k: 'ready', disabled: false, onclick: pressBet, label: `<span class="bl"><span class="bt">Bet ${fmtA(betting.stake)}</span> <span class="bp">→ ${fmtAmount(q.payout)}</span></span>`,
    hint: quorumNote() || 'One bet per round · locked once sent' };
}

/** "2 of 3 players in · stakes returned if short" while a table with a minimum has not reached it. */
function quorumNote(lead = '') {
  const t = betting.tableInfo, need = t ? t.minPlayers : 0;
  return need && betting.real < need ? `${lead}${betting.real} of ${need} players in${lead ? '' : ' · stakes returned if short'}` : '';
}

function renderBetButton() {
  const v = dockView();
  const key = [v.k, v.label, v.disabled, v.hint, v.head, v.forTxt, v.stakeLbl, v.steps, v.notice && v.notice.msg].join('\u0001');
  if (key === dockLast) return;
  dockLast = key;
  const btn = $('placeBet');
  btn.dataset.k = v.k;
  $('slip').dataset.k = v.k;
  btn.disabled = !!v.disabled;
  btn.setAttribute('aria-busy', v.k === 'busy');
  btn.innerHTML = v.label;
  btn.onclick = v.onclick || null;

  $('slipHead').hidden = v.head !== 'stake';
  $('stakeLbl').textContent = v.stakeLbl;
  $('betFor').innerHTML = v.forTxt;
  const st = $('betSteps');
  st.hidden = v.head !== 'steps';
  if (!st.hidden) { st.innerHTML = stepsHtml(v.steps); st.setAttribute('aria-valuenow', v.steps); st.setAttribute('aria-label', `Bet progress: step ${v.steps} of 3`); }
  const nt = $('betNotice');
  nt.hidden = v.head !== 'notice';
  if (!nt.hidden) nt.innerHTML = `<span class="tag">${v.notice.tag}</span><span class="msg" title="${esc(v.notice.msg)}">${esc(v.notice.msg)}</span>`;
  $('betHint').innerHTML = v.hint;
  const cancel = $('betCancel');
  if (cancel) cancel.onclick = () => { if (betting.cancelBet) betting.cancelBet(); };
}

/** A bet that did not go through (R1: everything unlocks, the pick and the stake are kept). */
function onBetFailed(msg) {
  const wn = walletName();
  betFail = /cancelled in the wallet|declin|reject|denied/i.test(msg) ? `Declined in ${wn} · no ${cur()} spent`
    : /^bet cancelled$/i.test(msg) ? `Cancelled · no ${cur()} spent`
    : String(msg).replace(/^./, (c) => c.toUpperCase());
  sfx.play('error');
  renderTote();
}

/* ------------------------- the timing tower -------------------------- */

// GAP TO THE LEADER = how long ago the front of the race was where this
// marble is now. The front (the furthest anyone has got) only moves forward,
// so it is recorded as a list of (depth, time) and looked up by each
// marble's own depth. Tried first as F1 timing loops at section boundaries:
// a marble past one more loop could show a BIGGER gap than one behind it,
// and the tower read out of order. This version cannot.
let frontY = [], frontT = [], flags = [];
let towerRows = null, towerOrder = [];

function resetTower() {
  frontY = []; frontT = [];
  flags = MARBLE_DATA.map(() => ({ warp: 0 }));
  const ol = $('standings');
  ol.innerHTML = '';
  towerRows = MARBLE_DATA.map((d, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', d.hex);
    li.innerHTML = `<span class="pos"></span><span class="stripe"></span>` +
      `<span class="who"><b class="num">${i + 1}</b><span class="nm">${d.name}</span><i class="tk">${d.ticker}</i></span>` +
      `<span class="rt"><em class="mine-tag">MINE</em><span class="gap"></span></span>`;
    ol.appendChild(li);
    return li;
  });
  towerOrder = [];
}

/** Advance the front of the race. Call after every racing tick. */
function timeLoops() {
  let p = -Infinity;
  for (const m of engine.marbles) if (!m.out) p = Math.max(p, m.progress);
  if (!frontY.length || p > frontY[frontY.length - 1] + 2) { frontY.push(p); frontT.push(engine.time); }
}

/** When the front of the race first reached depth y. */
function frontAt(y) {
  let lo = 0, hi = frontY.length - 1;
  if (hi < 0 || y > frontY[hi]) return engine.time;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frontY[mid] >= y) hi = mid; else lo = mid + 1; }
  return frontT[lo];
}

function gapText(m, lead) {
  if (m.out) return ['<span class="flag out">OUT</span>', ''];
  if (m === lead) return [m.finished ? `${m.finishTime.toFixed(2)}` : 'LEADER', 'lead'];
  if (m.finished) return [`+${(m.finishTime - lead.finishTime).toFixed(3)}`, ''];
  return [`+${Math.max(0, engine.time - frontAt(m.progress)).toFixed(3)}`, ''];
}

function renderStandings() {
  if (!towerRows) return;
  const order = engine.standings();
  const lead = order[0];
  const preRace = phase === PHASE.BETTING || phase === PHASE.READY || phase === PHASE.COUNTDOWN;
  const rowGap = parseFloat(getComputedStyle($('standings')).getPropertyValue('--row-gap')) || 4;
  const h = towerRows[0].offsetHeight + rowGap;
  $('standings').style.height = `${h * order.length - rowGap}px`;
  const mine = betting.placed ? betting.selected : -1;
  order.forEach((m, i) => {
    const li = towerRows[m.index];
    const was = towerOrder.indexOf(m.index);
    if (was >= 0 && was !== i && !preRace) {
      li.classList.remove('gain', 'loss'); void li.offsetWidth;
      li.classList.add(i < was ? 'gain' : 'loss');
    }
    li.style.transform = `translateY(${i * h}px)`;
    li.style.order = i;
    li.querySelector('.pos').textContent = i + 1;
    li.classList.toggle('out', m.out);
    li.classList.toggle('p1', i === 0);
    li.classList.toggle('mine', m.index === mine);
    let [txt, cls] = preRace ? ['', ''] : gapText(m, lead);
    if (!preRace && !m.out) {
      if (m.frozen && engine.tick < m.frozen) txt = `<span class="flag ice">${m.frozenBy === 'grab' ? 'CLAW' : 'ICE'}</span>`;
      else if (m.held) txt = `<span class="flag warp">${engine.track.cannons[m.held.cannon]?.kind === 'bridge' ? 'BRIDGE' : 'LAUNCH'}</span>`;
      else if (flags[m.index].warp > performance.now()) txt = '<span class="flag warp">WARP</span>';
    }
    const g = li.querySelector('.gap');
    if (g.innerHTML !== txt) g.innerHTML = txt;
    g.className = `gap ${cls}`;
  });
  towerOrder = order.map(m => m.index);

  const band = track.sections.find(s => lead && lead.y >= s.y0 && lead.y < s.y1);
  const name = preRace ? 'Starting grid'
    : lead && lead.y > track.finishY ? 'Finish' : (band ? band.name : 'Run-in');
  if ($('sectionName').textContent !== name) $('sectionName').textContent = name;
  const rnd = `Round ${betting.round}`, st = preRace ? 'GRID' : phase === PHASE.FINISHED ? 'FINISH' : 'RACING';
  if ($('towerRound').textContent !== rnd) $('towerRound').textContent = rnd;
  if ($('towerState').textContent !== st) $('towerState').textContent = st;
  for (const b of document.querySelectorAll('#camCoins button')) {
    const out = !!engine.marbles[+b.dataset.cam]?.out;
    if (out !== b.classList.contains('out')) { b.classList.toggle('out', out); b.setAttribute('aria-disabled', out); }
  }
}

/* ----------------------- my marble and the final pool ------------------- */

const ORD = ['1st', '2nd', '3rd', '4th', '5th'];
let myLast = '', myIdx = -1;

/** Seconds a marble is behind the front of the race, the same figure the tower shows. */
const behind = (m) => Math.max(0, engine.time - frontAt(m.progress));

/** What my marble is doing and what it pays, for the My marble card (desktop) and the peek bar (phones) alike. */
function myInfo(idx) {
  const d = MARBLE_DATA[idx], order = engine.standings(), pos = order.findIndex(m => m.index === idx), m = engine.marbles[idx];
  const pre = phase === PHASE.COUNTDOWN || phase === PHASE.BETTING || phase === PHASE.READY;
  const stake = betting.stake;
  const win = betting.oddsFor(idx, 0), pl = betting.oddsFor(idx, 1);
  const pay = (o) => (m.out || o === null || o === undefined ? '-' : fmtAmount(o * stake, 2));
  let title, detail = '';
  if (m.out) { title = `${d.name} is out`; detail = 'Knocked out, so this bet cannot pay'; }
  else if (pre) { title = `${d.name} on the grid`; detail = 'Race starts shortly'; }
  else if (m.finished) { title = `${d.name} finished ${ORD[pos]}`; detail = `${m.finishTime.toFixed(2)}s`; }
  else {
    title = `${d.name} running ${ORD[pos]}`;
    if (pos === 0) { const nx = order[1]; detail = nx && !nx.out ? `Leading, +${behind(nx).toFixed(2)} clear of ${MARBLE_DATA[nx.index].name}` : 'Leading'; }
    else { const ah = order[pos - 1]; detail = `+${Math.max(0, behind(m) - (ah === order[0] ? 0 : behind(ah))).toFixed(2)} to ${MARBLE_DATA[ah.index].name}`; }
  }
  return { d, pos, m, pre, stake, win, pl, pay, title, detail, following: camMode === idx && !m.out };
}

/**
 * The My marble card: where my marble is, and what 1st and 2nd would pay on the CLOSED pool.
 * The figures are stake / pool on my marble * net pool * the place share: the nominal
 * payout settlement uses (it only ever pays more, when a paying place had no backers).
 */
function renderMyMarble() {
  const el = $('myMarble');
  if (!el || !document.body.classList.contains('race-on')) return;
  const guest = !!betting.guest;
  const idx = !guest && betting.placed && betting.selected >= 0 ? betting.selected : -1;
  myIdx = idx;
  let html, cls = 'mycard', detail = '';
  if (idx < 0) {
    cls += ' watch';
    html = `<div class="mc-top"><span class="tagbox">WATCHING</span><span class="lbl">${guest ? 'Signed out' : 'No bet'}</span></div>` +
      `<p class="mc-title">${guest ? 'Watching · Connect a wallet to play the next round' : 'You are not in this round'}</p>` +
      `<p class="mc-sub">Round ${betting.round + 1} betting opens after this race.${guest ? ' Players never need SOL.' : ''}</p>` +
      (guest ? `<button type="button" class="cta" id="myConnect">Connect</button>` : '');
  } else {
    const { d, pos, m, pre, stake, win, pl, pay, title, detail: det, following } = myInfo(idx);
    detail = det;
    cls += m.out ? ' out' : ` mine${following ? ' following' : ''}`;
    html = `<div class="mc-top"><span class="lbl">My marble</span><span class="mc-id"><span class="tok" style="--c:${d.hex}">${idx + 1}</span><b>${String(idx + 1).padStart(2, '0')} ${d.ticker}</b></span></div>` +
      `<div class="mc-main"><span class="mc-pos">${m.out ? 'OUT' : pre ? '-' : 'P' + (pos + 1)}</span><div class="mc-txt"><span class="mc-title">${esc(title)}</span><span class="mc-detail"></span></div></div>` +
      `<div class="mc-rule"></div>` +
      `<div class="mc-pay"><div><span class="lbl">1st would pay</span><b>${pay(win)}</b></div><div><span class="lbl">2nd pays</span><b>${pay(pl)}</b></div><span class="mc-bet">Bet ${fmtA(stake)} ${esc(cur())}</span></div>` +
      `${m.out ? '' : `<div class="mc-follow">${following ? '<b>FOLLOWING</b> · tap to release the camera' : 'Tap to follow this marble'}</div>`}`;
  }
  // The gap line changes every few frames; it is written in place. Rebuilding the markup under the
  // pointer would drop a click, so the markup is only rebuilt when something structural changes.
  const dEl = el.querySelector('.mc-detail');
  if (html === myLast && el.className === cls) {
    if (dEl && dEl.textContent !== detail) dEl.textContent = detail;
    return;
  }
  myLast = html;
  el.className = cls;
  el.hidden = false;
  el.innerHTML = html;
  const nd = el.querySelector('.mc-detail');
  if (nd) nd.textContent = detail;
  if (idx >= 0 && !engine.marbles[idx].out) { el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-pressed', camMode === idx); }
  else { el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('aria-pressed'); }
}
const toggleFollow = () => { if (myIdx >= 0 && !engine.marbles[myIdx].out) setCam(camMode === myIdx ? 'auto' : myIdx); };
$('myMarble').onclick = (e) => {
  if (e.target.closest('#myConnect')) { openWallet(); return; }
  toggleFollow();
};
$('myMarble').onkeydown = (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggleFollow(); }
};

/**
 * The phone's race peek bar (frames 7 and S2): the sheet, locked at peek, is this and nothing else at the bottom.
 * My marble in one line with what 2nd pays, tap to follow it; for a spectator, Connect at the thumb.
 */
let peekLast = '';
function renderPeek() {
  const el = $('peekBar'), rail = $('rail');
  if (!el || !phone.matches || !document.body.classList.contains('race-on')) return;
  const guest = !!betting.guest;
  const idx = !guest && betting.placed && betting.selected >= 0 ? betting.selected : -1;
  rail.classList.toggle('mine', idx >= 0);
  let html = '';
  if (phase !== PHASE.RACING) html = '';
  else if (idx < 0) {
    html = `<div class="pk spec"><div class="pk-txt"><span class="tagbox">WATCHING</span>` +
      `<span class="pk-s">${guest ? 'Connect to play next round' : 'You are not in this round'}</span></div>` +
      (guest ? `<button type="button" class="cta" id="peekConnect">${ICON.wallet}Connect</button>` : '') + `</div>`;
  } else {
    const { d, pos, m, pre, stake, win, pl, pay, title, following } = myInfo(idx);
    const sub = m.out ? 'Knocked out, so this bet cannot pay' : m.finished ? `Bet ${fmtA(stake)} · ${m.finishTime.toFixed(2)}s`
      : `Bet ${fmtA(stake)} · 1st would pay ${pay(win)}`;
    html = (following ? `<span class="pk-follow"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg>FOLLOWING ${esc(d.name.toUpperCase())}</span>` : '') +
      `<div class="pk"><span class="tok" style="--c:${d.hex}">${pad2(idx)}</span>` +
      `<div class="pk-txt"><span class="pk-t"><b>${m.out ? 'OUT' : pre ? '-' : 'P' + (pos + 1)}</b>${esc(title)}</span><span class="pk-s">${esc(sub)}</span></div>` +
      (m.out ? '' : `<div class="pk-pay"><span class="lbl">2nd pays</span><b>${pay(pl)}</b></div>`) + `</div>`;
  }
  const key = html + (idx >= 0 && !engine.marbles[idx].out ? '|f' : '');
  if (key === peekLast) return;
  peekLast = key;
  el.innerHTML = html;
  if (idx >= 0 && !engine.marbles[idx].out) { el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-pressed', camMode === idx); el.setAttribute('aria-label', `My marble, ${MARBLE_DATA[idx].name}. ${camMode === idx ? 'The camera is following it. Tap to release.' : 'Tap to follow it.'}`); }
  else { el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('aria-pressed'); el.removeAttribute('aria-label'); }
}
$('peekBar').onclick = (e) => {
  if (e.target.closest('#peekConnect')) { openWallet(); return; }
  toggleFollow();
};
$('peekBar').onkeydown = (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggleFollow(); }
};

/** The closed pool and what every marble pays, for the right stack once betting is shut. */
function renderFinalPool() {
  const ul = $('fpRows');
  if (!ul) return;
  const mine = betting.placed ? betting.selected : -1;
  $('fpTotal').textContent = fmtAmount(betting.totalPool, 2);
  $('fpCur').textContent = cur();
  $('fpNote').textContent = `Betting closed · top ${PLACE_SHARES.length} paid ${PLACE_SHARES.map(x => Math.round(x * 100)).join('/')}`;
  ul.innerHTML = MARBLE_DATA.map((d, i) => {
    const o = betting.pools[i] > 0 ? betting.oddsFor(i, 0) : null, p = betting.pools[i] > 0 ? betting.oddsFor(i, 1) : null;
    const out = !!(engine && engine.marbles[i] && engine.marbles[i].out);
    return `<li style="--c:${d.hex}"><span class="l"><span class="stripe"></span><span class="num">${i + 1}</span><b class="tk">${d.ticker}</b>` +
      `${i === mine ? '<em class="mine">MINE</em>' : ''}${out ? '<em class="o">OUT</em>' : ''}</span>` +
      `<span class="w">${o === null ? '-' : fmtOdds(o)}</span><span class="p">${p === null ? '-' : fmtOdds(p)}</span></li>`;
  }).join('');
}

/* ------------------------------ start lights ---------------------------- */

/** Frame 9: three lamps, one lit per second (1, 2, 3 as the number goes 3, 2, 1); all out at GO, instantly. */
let lastTick = 0;
function renderGantry() {
  const lamps = $('gantry').children, n = Math.max(1, Math.ceil(countdown)), live = countdown > 0.15;
  const lit = live ? Math.min(3, 4 - n) : 0;
  for (let i = 0; i < 3; i++) lamps[i].classList.toggle('on', i < lit);
  $('gantry').classList.toggle('go', !live);
  if (live && n !== lastTick) {
    lastTick = n;
    // A short tick per second on phones, skipped when the player asked for less motion.
    if (navigator.vibrate && !reducedMotion() && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(10);
  }
  if (!live) lastTick = 0;
}

const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

/** The one chip under the countdown: "Riding Frost · 50 RUSH". Nothing for a spectator. */
function renderRidingChip() {
  const el = $('ridingChip'), i = !betting.guest && betting.placed ? betting.selected : -1;
  if (i < 0) { el.hidden = true; return; }
  el.innerHTML = `<span class="tok" style="--c:${MARBLE_DATA[i].hex}">${String(i + 1).padStart(2, '0')}</span><b>Riding ${esc(MARBLE_DATA[i].name)}</b>` +
    `<span class="dot">·</span><span class="amt">${fmtA(betting.stake)} ${esc(cur())}</span>`;
  el.hidden = false;
}

/* -------------------------------- confetti ------------------------------ */

/** Mix two #rrggbb colours: k of b, the rest a. */
const mix = (a, b, k) => '#' + [1, 3, 5].map(o => Math.round(parseInt(a.slice(o, o + 2), 16) * (1 - k) + parseInt(b.slice(o, o + 2), 16) * k).toString(16).padStart(2, '0')).join('');
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

let confetti = [];
/** Gold only: --celebrate belongs to winning and nothing else. `n` is the density (a win is full, a place a few). */
function launchConfetti(n = 160) {
  if (reducedMotion()) return;
  const c = $('confetti'), dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  const gold = cssVar('--celebrate') || '#E6C77A', light = cssVar('--light') || '#F4EFE6';
  const cols = [gold, gold, light, mix(gold, '#ffffff', .5), mix(gold, '#000000', .25)];
  for (let i = 0; i < n; i++) {
    confetti.push({ x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.42,
      vx: (Math.random() - 0.5) * 900, vy: -300 - Math.random() * 700, r: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 12, w: 5 + Math.random() * 6, h: 8 + Math.random() * 8,
      c: cols[i % cols.length], life: 2.6 + Math.random() * 1.2 });
  }
}
function drawConfetti(dt) {
  if (!confetti.length) return;
  const c = $('confetti'), g = c.getContext('2d'), dpr = c.width / innerWidth;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, innerWidth, innerHeight);
  for (const p of confetti) {
    p.life -= dt; p.vy += 900 * dt; p.vx *= 0.99; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
    g.save(); g.translate(p.x, p.y); g.rotate(p.r);
    g.globalAlpha = Math.max(0, Math.min(1, p.life));
    g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 1.7)));
    g.restore();
  }
  confetti = confetti.filter(p => p.life > 0 && p.y < innerHeight + 40);
  if (!confetti.length) g.clearRect(0, 0, innerWidth, innerHeight);
}

/* -------------------------------- results ------------------------------- */

/** 3:31.42, the way the tower and the design write a race time. */
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
/** The topbar race clock: 42.17s under a minute, then 3:31.42 like the tower. */
const fmtRace = (t) => (t < 60 ? `${t.toFixed(2)}s` : fmtTime(t));
const signed = (v) => `${v < 0 ? '−' : '+'}${fmtAmount(Math.abs(v))}`;
const pad2 = (i) => String(i + 1).padStart(2, '0');
const tokHtml = (i, cls = '') => `<span class="tok ${cls}" style="--c:${MARBLE_DATA[i].hex}">${pad2(i)}</span>`;
let resultKind = '';

/**
 * The result screen (frames 11a to 11d). The course stays up; the personal panel is one of five:
 * win (1st and in profit), place (paid, any other way: quiet), loss (backed, not paid), void (stake returned),
 * watch (no bet). The figures come from settleInfo and the committed run, never from the live engine.
 */
function showResult() {
  const si = settleInfo, order = result.finishOrder, ko = (i) => result.eliminated.includes(i);
  const winIdx = order[0], win = MARBLE_DATA[winIdx], rnd = finishedRound;
  const mine = si.backed >= 0 ? si.backed : -1;
  const voided = !!si.void, hasBet = mine >= 0 && !voided;
  resultKind = voided && mine >= 0 ? 'void'
    : si.place >= 0 && !voided ? (si.place === 0 && si.profit > 0 ? 'win' : 'place')
    : hasBet ? 'loss' : 'watch';
  sfx.play(resultKind);
  const body = document.body;
  body.classList.add('results');
  renderer.setSpotlight(-1, '');

  // Podium card: the winner large, then P2 and P3. A voided round has no result to show.
  const top3 = order.filter(i => !ko(i)).slice(0, 3);
  $('pcTag').textContent = voided ? 'No result' : 'Winner';
  $('podiumCard').classList.toggle('void', voided);
  $('winSwatch').hidden = voided;
  $('winSwatch').className = `tok lg${winIdx === mine && hasBet ? ' mine' : ''}`;
  $('winSwatch').style.setProperty('--c', win.hex);
  $('winSwatch').textContent = pad2(winIdx);
  $('winName').textContent = voided ? 'No result' : win.name;
  $('winSub').textContent = voided ? `Round ${rnd} was voided` : `${pad2(winIdx)} ${win.ticker}${winIdx === mine && hasBet ? ' · MINE' : ''}`;
  $('winTime').textContent = voided ? '' : fmtTime(result.times[winIdx]);
  $('podium').innerHTML = voided ? '' : [1, 2].filter(k => top3[k] !== undefined).map(k =>
    `<div class="pd"><span class="p">P${k + 1}</span><span class="tok sm" style="--c:${MARBLE_DATA[top3[k]].hex}">${top3[k] + 1}</span><b>${MARBLE_DATA[top3[k]].ticker}</b><span class="t">${fmtTime(result.times[top3[k]])}</span></div>`).join('');

  // Final order: committed times, knockouts as OUT.
  $('foTitle').textContent = `Final order · R${rnd}`;
  $('foState').textContent = voided ? 'NO RESULT' : 'FINISHED';
  const ol = $('finalOrder');
  ol.innerHTML = '';
  order.forEach((idx, i) => {
    const d = MARBLE_DATA[idx], out = ko(idx), li = document.createElement('li');
    li.className = (idx === mine && hasBet ? 'mine ' : '') + (out ? 'out' : '');
    li.style.setProperty('--c', d.hex);
    li.innerHTML = `<span class="pos">${out ? '—' : i + 1}</span><span class="stripe"></span>` +
      `<span class="who"><b class="num">${pad2(idx)}</b><span class="nm">${esc(d.name)}</span><i class="tk">${d.ticker}</i>${idx === mine && hasBet ? '<em class="mt">MINE</em>' : ''}</span>` +
      (out ? '<span class="oo">OUT</span>' : `<span class="ft">${fmtTime(result.times[idx])}</span>`);
    ol.appendChild(li);
  });

  // Phones: the podium is three tiles (P1 P2 P3 with times), not the desktop's winner card.
  $('podiumM').innerHTML = voided ? '<div class="pt none">No result</div>' : top3.map((idx, k) =>
    `<div class="pt p${k + 1}"><span class="r"><b>P${k + 1}</b><i style="--c:${MARBLE_DATA[idx].hex}"></i><span>${pad2(idx)} ${MARBLE_DATA[idx].ticker}</span></span><span class="t">${fmtTime(result.times[idx])}</span></div>`).join('');

  renderMyResult(si, { winIdx, rnd, mine, hasBet, ko });
  renderResultLinks();

  // Win: the full celebration. Place: a few particles. Everything else: nothing moves.
  $('resultOverlay').hidden = false;
  if (phone.matches) resSheet.set('half');
  if (resultKind === 'win') { launchConfetti(160); renderer.setSpotlight(winIdx, cssVar('--celebrate-glow')); }
  else if (resultKind === 'place') launchConfetti(24);
  setRaceLayout(true);
}

/** The right-hand stack: my result, and the next-round ring (the hero when there is nothing to celebrate). */
function renderMyResult(si, { winIdx, rnd, mine, hasBet, ko }) {
  const el = $('myResult'), kind = resultKind, ORDn = ['1st', '2nd', '3rd', '4th', '5th'];
  const name = mine >= 0 ? MARBLE_DATA[mine].name : '';
  el.className = `myres ${kind === 'loss' || kind === 'void' ? 'quiet ' : ''}${kind}`;
  $('resConnect').hidden = !(kind === 'watch' && betting.guest);
  $('nextConnect').hidden = !betting.guest;               // phones: Connect sits in the pinned next-round bar
  $('resCur').textContent = cur();
  $('burst').innerHTML = '';
  $('resWho').textContent = kind === 'watch' ? `Round ${rnd}` : `My result · ${name} ${MARBLE_DATA[mine].ticker}`;
  const tok = $('resTok');
  tok.hidden = kind === 'watch' || kind === 'void';
  if (mine >= 0) { tok.className = 'tok lg'; tok.style.setProperty('--c', MARBLE_DATA[mine].hex); tok.textContent = pad2(mine); }
  const stat = (l, v, dim) => `<div><span class="lbl">${l}</span><b${dim ? ' class="dim"' : ''}>${v}</b></div>`;
  const line = $('resLine');
  line.hidden = true;
  let amount = 0, stats = '', count = false;

  if (kind === 'win' || kind === 'place') {
    amount = si.payout ?? si.profit + si.stake;
    $('resTag').textContent = kind === 'win' ? 'WIN' : 'PLACE';
    $('resHead').textContent = `${ORDn[si.place]} · ${name}`;
    $('resPayLbl').textContent = kind === 'win' ? 'Payout' : si.place === 1 ? 'Runner-up pays' : `${ORDn[si.place]} pays`;
    // The sign comes from the PROFIT, never the position: a paid marble can still pay back less than its stake.
    stats = stat('Profit', signed(si.profit)) + stat('Return', fmtOdds(si.odds)) + stat('Bet', fmtA(si.stake), true);
    count = kind === 'win' && !reducedMotion();
  } else if (kind === 'loss') {
    const wo = betting.oddsFor(winIdx, 0), at = result.finishOrder.indexOf(mine);
    $('resTag').textContent = 'NO PAYOUT';
    $('resHead').textContent = 'Not this time';
    line.hidden = false;
    line.textContent = `${ko(mine) ? `${name} was knocked out.` : `${name} finished ${ORDn[at]}.`} ${MARBLE_DATA[winIdx].name} won${wo ? ` at ${fmtOdds(wo)}` : ''}.`;
    $('resPayLbl').textContent = 'Payout';
    stats = stat('Profit', signed(-si.stake), true) + stat('Bet', fmtA(si.stake), true) + stat('Finished', ko(mine) ? 'OUT' : ORDn[at], true);
  } else if (kind === 'void') {
    amount = si.payout ?? si.stake;
    $('resTag').textContent = 'REFUND';
    $('resHead').textContent = `Round ${rnd} was voided`;
    line.hidden = false; line.textContent = 'Your stake was returned.';
    $('resPayLbl').textContent = 'Returned';
    stats = stat('Profit', fmtAmount(0)) + stat('Bet', fmtA(si.stake), true) + stat('Round', rnd, true);
  } else {
    $('resTag').textContent = 'WATCHING';
    $('resHead').textContent = 'You watched this round';
    line.hidden = false;
    line.textContent = betting.guest ? `Connect a wallet to bet on round ${rnd + 1}.` : `Betting on round ${rnd + 1} opens soon.`;
  }
  $('resStats').innerHTML = stats;
  const out = $('payout');
  const show = (v) => { out.textContent = `${kind === 'void' ? '+' : ''}${fmtAmount(v)}`; };
  if (count) {
    const t0 = performance.now();
    show(0);
    const step = (now) => { const k = Math.min(1, (now - t0) / 1200), e = 1 - Math.pow(1 - k, 3); show(amount * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  } else show(amount);

  // Next round: a ring on a server round; a plain Start button on a local one (no shared clock there).
  $('resStack').classList.toggle('hero', kind === 'loss' || kind === 'void' || kind === 'watch');
  $('nextLbl').textContent = `Next round · ${rnd + 1}`;
  $('nextRace').hidden = NET;
  $('nextRace').classList.toggle('go', !NET);
  $('nextRace').textContent = `Start round ${rnd + 1}`;
  nextShown = '';
  renderNext();
}

/** The next-round ring: counts the server's own clock down to betting. Written only when the second changes. */
const NEXT_C = 2 * Math.PI * 42;
let nextShown = '';
function renderNext() {
  if (phase !== PHASE.FINISHED) return;
  const fill = $('nextFill');
  if (NET && netRound && netRound.nextAt) {
    const left = Math.max(0, (netRound.nextAt - betting.now()) / 1000);
    const total = Math.max(1, (netRound.nextAt - (netRound.resultAt || netRound.nextAt - 15000)) / 1000);
    fill.style.strokeDashoffset = (NEXT_C * (1 - Math.min(1, left / total))).toFixed(1);
    const secs = Math.ceil(left), key = String(secs);
    if (key !== nextShown) {
      nextShown = key;
      $('nextSecs').textContent = secs;
      $('nextNote').textContent = secs > 0 ? `Betting opens in ${secs}s` : 'Betting opens now';
    }
  } else if (nextShown !== 'local') {
    nextShown = 'local';
    fill.style.strokeDashoffset = '0';
    $('nextSecs').textContent = '-';
    $('nextNote').textContent = `Round ${finishedRound + 1} is ready`;
  }
}

/** Links that need Solana's word: the round-level paid-out pill, my own "Paid out" link, the proof bar. */
function renderResultLinks() {
  const pill = $('paidPill'), mineBtn = $('resPaid');
  const p = NET && netRound && betting.payouts ? betting.payouts.get(netRound.id) : null;
  const ok = !!(p && p.status === 'confirmed' && p.sigs.length) && !$('resultOverlay').hidden;
  const refund = !!(p && p.kind === 'refund');
  const sig = ok ? p.sigs[0] : '', short = sig ? `${sig.slice(0, 3)}...${sig.slice(-3)} ↗` : '';
  const open = () => window.open(explorer(sig, betting.cluster), '_blank', 'noopener,noreferrer');
  pill.hidden = !ok;
  document.body.classList.toggle('paid', ok);
  if (ok) { $('paidTxt').textContent = refund ? 'Refunded on Solana' : 'Round paid out on Solana'; $('paidSig').textContent = short; pill.onclick = open; }
  // R3: the personal line appears only when this player really was paid (or refunded), and the chain says so.
  const mineOk = ok && ((resultKind === 'win' || resultKind === 'place') && (settleInfo?.payout ?? 0) > 0 && !refund || resultKind === 'void' && refund);
  mineBtn.hidden = !mineOk;
  if (mineOk) {
    mineBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>${resultKind === 'void' ? 'Refunded on Solana' : 'Paid out on Solana'} <code>${esc(short)}</code>`;
    mineBtn.onclick = open;
  }
}

/* ----------------------------- bottom sheets ----------------------------- */

// Phones only. The market rail and the result panel are bottom sheets with three snaps (peek, half, full) and a
// drag handle. The renderer frames the course around a sheet, so it is re-framed once the sheet lands, not on
// every frame of a drag (that would resize the canvas sixty times a second).
const phone = window.matchMedia ? matchMedia('(max-width: 900px)') : { matches: false, addEventListener() {} };
let sheetBusy = false, sheetTimer = 0;
const safeProbe = document.createElement('div');
safeProbe.setAttribute('aria-hidden', 'true');
safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:var(--safe-b);pointer-events:none;visibility:hidden';
document.body.append(safeProbe);
const safeBottom = () => safeProbe.offsetHeight;
const SHEET_TOP = 72;                                     // a full sheet stops under the top bar
const SNAPS = ['peek', 'half', 'full'];

function reframeSoon() {
  clearTimeout(sheetTimer);
  sheetBusy = true;
  sheetTimer = setTimeout(() => { sheetBusy = false; if (renderer) renderer.resize(); }, reducedMotion() ? 30 : 340);
}

/**
 * `heights()` gives the sheet's three heights in px (safe area included). The sheet is `el`, dragged by `grab`.
 * Returns { set(name), refresh(), lock(on), snap }.
 */
function makeSheet({ el, grab, heights, initial = 'half', onSnap }) {
  let snap = initial, h = null, drag = null, moved = false, locked = false, key = '';
  const px = (n) => `${Math.round(n)}px`;
  const apply = () => {
    el.dataset.snap = snap;
    el.style.setProperty('--sheet-h', px(h[snap]));
    if (snap !== 'full') el.scrollTop = 0;
    if (onSnap) onSnap(snap);
    reframeSoon();
  };
  const api = {
    get snap() { return snap; },
    get locked() { return locked; },
    set(name) { h = heights(); snap = name; key = JSON.stringify(h); apply(); },
    /** Re-measure; only moves the sheet when the numbers changed. */
    refresh() {
      if (drag) return;
      const nh = heights(), k = JSON.stringify(nh);
      if (k === key) return;
      h = nh; key = k; apply();
    },
    lock(on, to) { locked = on; el.classList.toggle('locked', on); if (to) api.set(to); },
  };
  grab.addEventListener('pointerdown', (e) => {
    if (locked || (e.button && e.button > 0)) return;
    h = heights();
    drag = { y0: e.clientY, h0: el.getBoundingClientRect().height, y: e.clientY, t: e.timeStamp, v: 0 };
    moved = false;
    try { grab.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic pointer has nothing to capture */ }
    el.classList.add('dragging');
    sheetBusy = true;
  });
  grab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dy) > 4) moved = true;
    const dt = Math.max(1, e.timeStamp - drag.t);
    drag.v = (drag.y - e.clientY) / dt;                    // px per ms, up is positive
    drag.y = e.clientY; drag.t = e.timeStamp;
    el.style.setProperty('--sheet-h', px(Math.max(h.peek, Math.min(h.full, drag.h0 - dy))));
  });
  const end = (e) => {
    if (!drag) return;
    const cur = el.getBoundingClientRect().height, v = drag.v;
    drag = null;
    el.classList.remove('dragging');
    setTimeout(() => { moved = false; }, 60);                 // a drag is not a tap, whether or not the browser sends a click after it
    if (!moved) { sheetBusy = false; return; }                // a tap: the click handler below decides
    const aim = cur + v * 180;                                // a flick carries the sheet on
    snap = SNAPS.reduce((best, n) => (Math.abs(h[n] - aim) < Math.abs(h[best] - aim) ? n : best), 'half');
    apply();
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  grab.addEventListener('click', () => {
    if (moved) { moved = false; return; }
    if (locked) return;
    api.set(snap === 'half' ? 'full' : 'half');
  });
  grab.addEventListener('keydown', (e) => {
    if (locked || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const i = SNAPS.indexOf(snap) + (e.key === 'ArrowUp' ? 1 : -1);
    api.set(SNAPS[Math.max(0, Math.min(2, i))]);
  });
  return api;
}

const railSheet = makeSheet({
  el: $('rail'), grab: $('sheetGrab'),
  heights() {
    const safe = safeBottom(), tote = $('tote'), slip = $('slip');
    // Half is exactly the market and the dock: the rows end, 8px, the dock. A short screen caps it and the rows scroll.
    const half = tote.offsetTop + tote.offsetHeight + 8 + slip.offsetHeight;
    return { peek: 88 + safe, half: Math.min(Math.max(half, 88 + safe), Math.round(innerHeight * 0.72)), full: innerHeight - SHEET_TOP };
  },
  onSnap(s) { document.body.classList.toggle('sheet-full', s === 'full'); },
});
const resSheet = makeSheet({
  el: $('resSheet'), grab: $('resGrab'),
  heights() {
    const safe = safeBottom();
    return { peek: 72 + 16 + 72 + safe, half: Math.round(innerHeight * 0.64), full: innerHeight - SHEET_TOP };
  },
});

/** Betting: the market sheet opens at half. From the countdown on it is the race peek bar and cannot be moved. */
function syncSheets() {
  if (!phone.matches) return;
  const race = document.body.classList.contains('race-on');
  if (race && !railSheet.locked) railSheet.lock(true, 'peek');
  else if (!race && (railSheet.locked || !$('rail').dataset.snap)) { railSheet.lock(false); railSheet.set('half'); }
  else if (!race) railSheet.refresh();
}
phone.addEventListener && phone.addEventListener('change', () => { syncSheets(); if (!$('resultOverlay').hidden) resSheet.set('half'); if (NET) renderAccount(); });
// The latest-bet line opens the rest of the sheet.
$('betPeek').onclick = () => { if (!railSheet.locked) railSheet.set('full'); };
$('walletRow').onclick = () => openWallet();
if ('ResizeObserver' in window) {
  const rows = new ResizeObserver(() => { if (phone.matches && !document.body.classList.contains('race-on')) railSheet.refresh(); });
  rows.observe($('tote')); rows.observe($('slip'));
}
window.addEventListener('resize', () => { if (phone.matches) { if (!$('resultOverlay').hidden) resSheet.refresh(); syncSheets(); } });

/* ------------------------------- wake lock ------------------------------- */

// Keep the screen on from the lights to the flag: a race is minutes of watching, not touching. Feature-detected;
// the browser drops the lock when the tab is hidden, so it is taken again when the tab comes back.
let wakeLock = null;
async function syncWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const b = document.body.classList, want = (b.contains('countdown') || b.contains('racing')) && !document.hidden;
  try {
    if (want && !wakeLock) {
      const lock = await navigator.wakeLock.request('screen');
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      if (!(b.contains('countdown') || b.contains('racing'))) syncWakeLock();   // the race ended while the request was out
    } else if (!want && wakeLock) {
      const lock = wakeLock; wakeLock = null;
      await lock.release();
    }
  } catch (_) { /* refused (battery saver, permission): the screen may dim, nothing else changes */ }
}
new MutationObserver(syncWakeLock).observe(document.body, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('visibilitychange', syncWakeLock);

/* ------------------------------ the loop ------------------------------- */

let last = performance.now();

let paused = false;          // debug only: __mr2d.pause(), to inspect a frame

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (paused || !engine) { requestAnimationFrame(frame); return; }

  // The lobby clock runs through BOTH pre-race phases, so a table that readies
  // slowly is on the same hard stop as one that bets slowly. On a server round
  // it is the server's clock, read, not counted.
  if (NET && netRound) {
    // A table that starts on the first bet holds the clock full until someone bets.
    lobby = netRound.waiting && netRound.phase === 'betting' ? lobbyTotal() : Math.max(0, (netRound.closesAt - betting.now()) / 1000);
    if (phase === PHASE.COUNTDOWN) countdown = Math.max(0.01, (netRound.raceAt - betting.now()) / 1000);
  } else if (phase === PHASE.BETTING || phase === PHASE.READY) {
    lobby -= dt;
    if (lobby <= 0) closeLobby();
  }

  { const placed = !!betting.placed; if (placed && !placedSeen) sfx.play('bet'); placedSeen = placed; }
  if (phase !== PHASE.COUNTDOWN) cdSeen = 0;

  if (phase === PHASE.BETTING && NET) {
    engine.step(false);
  } else if (phase === PHASE.READY && NET) {
    engine.step(false);
  } else if (phase === PHASE.BETTING) {
    botTimer -= dt;
    if (botTimer <= 0 && betting.pendingBots.length) {
      betting.revealBot();
      renderTote();
      renderFeed();
      botTimer = 0.4 + Math.random() * 0.9;
    }
    engine.step(false);                      // let the field settle on the gate
  } else if (phase === PHASE.READY) {
    // Tick the other backers in, then start the countdown once the table is
    // full. Physics keeps running with racing=false: the field is settled and
    // this cannot move it anywhere the committed run did not go, because the
    // gate snapshot is restored the moment it lifts.
    let changed = false;
    for (let i = 0; i < readyIn.length; i++) {
      if (readyIn[i] <= 0) continue;
      readyIn[i] -= dt;
      if (readyIn[i] <= 0) { readyCount++; changed = true; }
    }
    if (changed) renderBetButton();
    engine.step(false);
    if (readyCount >= betting.bots.length + 1) enterCountdown();
  } else if (phase === PHASE.COUNTDOWN) {
    if (!NET) countdown -= dt;
    const cdShown = Math.max(1, Math.ceil(countdown));
    if (cdShown !== cdSeen) { cdSeen = cdShown; sfx.play('tick'); }
    $('countdownValue').textContent = cdShown;
    renderGantry();
    engine.step(false);
    if (countdown <= 0 && !NET) enterRacing();
  } else if (phase === PHASE.RACING) {
    // Fixed-step accumulator. The engine must never see a frame delta, or the
    // race stops being reproducible and the commitment means nothing.
    //
    // On a server round the replay is LOCKED to the server's clock instead:
    // however long this tab was hidden or throttled, it steps until it is at
    // the tick the server is at, so every viewer is watching the same moment.
    // Events from a long catch-up are not announced (they are old news).
    if (NET && netRound) {
      const want = Math.floor((betting.now() - netRound.raceAt) / 1000 / SIM_DT);
      const behind = want - engine.tick;
      if (behind > 240) {
        for (let i = 0; i < Math.min(behind, 240 * 60) && !engine.allFinished; i++) { engine.step(true); timeLoops(); noteSecond(); }
        accumulator = 0;
      } else accumulator = Math.max(0, behind) * SIM_DT + (accumulator % SIM_DT);
    } else accumulator += dt;
    let steps = 0;
    while (accumulator >= SIM_DT && steps < 600) {
      engine.step(true);
      // Events are per TICK and a frame runs several, so read them here or
      // most of them are overwritten before the frame ever sees them.
      for (const ev of engine.events) onRaceEvent(ev);
      soundImpacts();
      timeLoops();
      if (NET) noteSecond();
      accumulator -= SIM_DT;
      steps++;
    }
    if (accumulator > SIM_DT * 600) accumulator = 0;

    const fin = engine.marbles.reduce((n, m) => n + (m.finished ? 1 : 0), 0);
    if (fin > finSeen) { if (fin - finSeen <= 2) sfx.play('finish', finSeen); finSeen = fin; }
    recordFrame();
    // Race time stops when the last marble is home; the field rolls on into the basin after that.
    const home = engine.allFinished ? Math.max(0, ...engine.marbles.filter(m => m.finished).map(m => m.finishTime)) : 0;
    $('raceClock').textContent = fmtRace(home || engine.time);
    if (engine.allFinished || engine.time > MAX_RACE_SECONDS) {
      // A server round is over when the SERVER says so and has paid out; the
      // field rolls on into the basin until then.
      if (!NET) enterFinished();
      // A signed-out spectator is never sent a settlement, so for them the server's 'results' phase is enough.
      else if (netRound && netRound.phase === 'results' && (betting.guest || (betting.settled && betting.settled.id === netRound.id))) {
        result = netRound.result;
        enterFinished();
      }
    }
  } else {
    engine.step(false);
  }

  renderLobby();
  if (bannerTimer > 0) {
    bannerTimer -= dt;
    if (bannerTimer <= 0) $('banner').hidden = true;
  }
  renderStandings();
  renderCourseMap();
  renderMyMarble();
  renderPeek();
  renderer.update(dt, phase);
  renderer.draw(phase);

  // Leader cam. The main shot follows the PACK, so the leader leaves the frame
  // once the field strings out; this puts it back without compromising the
  // main view. Only worth drawing when there is a race to follow.
  drawSideCam();
  drawReplay(dt);
  drawConfetti(dt);
  renderNext();
  const why = phase === PHASE.RACING ? renderer.camWhy : '';
  const who = renderer.camSubject && phase === PHASE.RACING && (camMode === 'auto' ? renderer.camWhy && renderer.camWhy !== 'pack' : true)
    ? MARBLE_DATA[renderer.camSubject.index].name + (why && why !== 'pack' ? ' · ' + why : '') : why;
  if ($('camWhy').textContent !== (who || '')) $('camWhy').textContent = who || '';
  requestAnimationFrame(frame);
}

/* -------------------------------- boot --------------------------------- */

window.addEventListener('resize', () => renderer && renderer.resize());

// Re-frame the course whenever a PANEL changes size, not just the window. The
// tote is measured when the round opens, before its rows are filled in; it
// then grows to full height and, on a phone-sized screen, the start gate and
// the whole field were being drawn behind it for the entire betting phase.
if ('ResizeObserver' in window) {
  const ro = new ResizeObserver(() => { if (!sheetBusy && renderer) renderer.resize(); });
  for (const el of document.querySelectorAll('[data-hud]')) ro.observe(el);
}
$('nextRace').onclick = newRound;
$('resConnect').onclick = () => openWallet();
$('nextConnect').onclick = () => openWallet();

/* ------------------------------ the wallet ------------------------------ */

/* ------------------------------ appearance ------------------------------ */

const PALETTES = [['ivory', 'Ivory'], ['champagne', 'Champagne']];
const palette = window.mrPalette || { get: () => 'ivory', set() {} };   // palette.js is a plain script in <head>

/** The "Appearance" row: a two-option segmented control, shared by the wallet card and the onboarding sheet. */
function appearanceRow() {
  const cur = palette.get();
  return `<div class="appear"><span class="lbl" id="appearLbl">Appearance</span>` +
    `<div class="seg" role="radiogroup" aria-labelledby="appearLbl">` +
    PALETTES.map(([id, name]) => `<button type="button" role="radio" data-p="${id}" aria-checked="${id === cur}" tabindex="${id === cur ? 0 : -1}"><i class="sw"></i>${name}</button>`).join('') +
    `</div></div>`;
}
function syncAppearance() {
  const cur = palette.get();
  for (const b of document.querySelectorAll('.seg [data-p]')) {
    const on = b.dataset.p === cur;
    b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1;
  }
}
document.addEventListener('palettechange', syncAppearance);
// One delegated listener: the row is rebuilt every time the wallet card opens.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.seg [data-p]');
  if (b) palette.set(b.dataset.p);
});
document.addEventListener('keydown', (e) => {
  const b = e.target.closest && e.target.closest('.seg [data-p]');
  if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const i = PALETTES.findIndex(([id]) => id === b.dataset.p);
  const next = PALETTES[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + PALETTES.length) % PALETTES.length][0];
  palette.set(next);
  const nb = b.parentElement.querySelector(`[data-p="${next}"]`);
  if (nb) nb.focus();
});

function shortAddr(a) { return a ? `${a.slice(0, 4)}...${a.slice(-4)}` : ''; }

/** The top-bar button, and the balance, follow who is signed in. */
function renderAccount() {
  const guest = !!betting.guest;
  document.body.classList.toggle('guest', guest);
  const b = $('walletBtn');
  b.hidden = false;
  b.classList.toggle('out', guest);
  b.innerHTML = guest
    ? '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12.5h2M3 9h13a2 2 0 0 0 2-2V5"/></svg><span class="on">Connect</span><span class="off">Not connected</span><span class="watch">Watching</span>'
    : '<span class="av"><i></i></span><span class="addr"></span>';
  if (guest) b.setAttribute('aria-label', 'Connect wallet');
  else b.querySelector('.addr').textContent = shortAddr(betting.address);
  b.onclick = openWallet;
  b.tabIndex = phone.matches ? -1 : 0;                    // display-only on a phone: Connect is on the Bet button and the spectator bar
  $('walletRowTxt').textContent = guest ? 'Connect wallet' : shortAddr(betting.address);
  renderWallet();
  if (phase === PHASE.BETTING) renderBetButton();
}

const explorer = (sig, cluster) => `https://explorer.solana.com/tx/${sig}${cluster && cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : ''}`;

/* ---- the wallet card (frames W1 to W5): one card, four views: connect, connecting, failed, account ---- */

const WALLETS = [['phantom', 'Phantom'], ['solflare', 'Solflare'], ['backpack', 'Backpack']];
const SVG_CHEV = '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
const SVG_COPY = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const glyph = (s) => `<span class="wg" aria-hidden="true">${String(s).slice(0, 1).toUpperCase()}</span>`;
const GRAB = '<div class="whandle" id="walletGrab" aria-hidden="true"><i></i></div>';

let walletTimers = [];                 // timeouts and intervals that belong to the open card
let walletTry = 0;                     // bumped on every new attempt, cancel and close: a late answer from an old attempt is ignored
function clearWalletTimers() { for (const t of walletTimers) { clearTimeout(t); clearInterval(t); } walletTimers = []; }
function closeWallet() { clearWalletTimers(); walletTry++; $('walletOverlay').hidden = true; $('walletCard').style.transform = ''; }

function walletShow(html, focusSel) {
  clearWalletTimers();
  const card = $('walletCard');
  card.innerHTML = GRAB + html;
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'walletTitle');
  $('walletOverlay').hidden = false;
  const f = (focusSel && card.querySelector(focusSel)) || card;
  card.tabIndex = -1;
  try { f.focus({ preventScroll: true }); } catch (_) { /* nothing to focus */ }
}

/** W1: signed out. Detected wallets are buttons, the others point to the install page. */
function walletConnectView() {
  const found = walletProviders();
  const rows = WALLETS.map(([id, name]) => {
    const w = found.find(x => x.id === id);
    if (w) return `<button type="button" class="walletopt" data-w="${id}">${glyph(name)}<span class="wn">${name}<small>Detected</small></span>${SVG_CHEV}</button>`;
    const l = WALLET_LINKS.find(x => x.name === name);
    return l ? `<a class="walletopt" href="${l.url}" target="_blank" rel="noopener noreferrer">${glyph(name)}<span class="wn">${name}<small>Not installed</small></span><b class="inst">Install ↗</b></a>` : '';
  }).join('');
  walletShow(
    `<h2 class="wtitle" id="walletTitle">Connect a wallet to play</h2>` +
    `<p class="wnote">Sign a free message to play. It sends no transaction, costs no fee and gives us no access to your funds.</p>` +
    `<p class="wnote dim">Players never need SOL: bets are signed token transfers.</p>` +
    `<div class="wlist">${rows}</div>` +
    (found.length ? '' : `<p class="wnote dim">No wallet found in this browser. Install one, then reload this page.</p>`) +
    `<p class="walleterr" id="walletErr" role="status"></p>` +
    `<button type="button" id="walletClose" class="wlink">Watch without a wallet</button>` + appearanceRow(), '.walletopt');
  $('walletClose').onclick = closeWallet;
  for (const btn of $('walletCard').querySelectorAll('[data-w]')) btn.onclick = () => walletConnect(btn.dataset.w);
}

/** W2: waiting on the wallet popup. The popup cannot be aborted from here; Cancel just stops listening. */
function walletConnectingView(name, id) {
  walletShow(
    `<div class="wstate" role="status"><div class="wspin"><i class="wring"></i>${glyph(name)}</div>` +
    `<h2 class="wtitle" id="walletTitle">Connecting to ${name}</h2><b class="wtag">Waiting for approval</b>` +
    `<p class="wnote">Approve the connection in the ${name} window. MarbleRush only sees your address.</p></div>` +
    `<p class="walleterr" id="walletErr"></p><button type="button" id="walletCancel" class="wbtn ghost">Cancel</button>`, '#walletCancel');
  $('walletCancel').onclick = () => { walletTry++; walletConnectView(); };
}

/** W3: refused, no response, or the wallet is not there. Never red: the label and the glyph carry it. */
function walletFailedView({ id, name, title, text, install }) {
  walletShow(
    `<div class="wstate"><span class="wbang" aria-hidden="true">!</span><b class="wtag">NOT CONNECTED</b>` +
    `<h2 class="wtitle" id="walletTitle">${esc(title)}</h2><p class="wnote" id="walletErr" role="status">${esc(text)}</p></div>` +
    (install ? `<a class="wbtn" href="${install}" target="_blank" rel="noopener noreferrer">Install ${esc(name)} ↗</a>` : '') +
    `<button type="button" id="walletRetry" class="wbtn${install ? ' ghost' : ''}">Try again</button>` +
    `<button type="button" id="walletOther" class="wbtn ghost">Choose another wallet</button>`, install ? 'a.wbtn' : '#walletRetry');
  $('walletRetry').onclick = () => (id ? walletConnect(id) : walletConnectView());
  $('walletOther').onclick = walletConnectView;
}

async function walletConnect(id) {
  const name = (WALLETS.find(([i]) => i === id) || [id, 'your wallet'])[1];
  const w = walletProviders().find(x => x.id === id);
  if (!w) {
    const l = WALLET_LINKS.find(x => x.name === name);
    walletFailedView({ id, name, title: `${name} not found`, text: `No ${name} wallet was found in this browser. Install it, then try again.`, install: l && l.url });
    return;
  }
  const mine = ++walletTry;
  walletConnectingView(name, id);
  walletTimers.push(setTimeout(() => {
    if (mine !== walletTry) return;
    walletTry++;
    walletFailedView({ id, name, title: 'No response', text: `${name} did not answer in 60 seconds. Open the wallet window and try again.` });
  }, 60000));
  try {
    await signIn(w);
    location.reload();                                    // the session exists now: the page starts again signed in
  } catch (e) {
    if (mine !== walletTry) return;                       // cancelled, timed out or closed meanwhile
    walletTry++;
    const m = (e && e.message) || 'Sign-in failed';
    const refused = /cancelled|declined|reject|denied/i.test(m);
    walletFailedView(refused
      ? { id, name, title: 'Connection refused', text: `The request was declined in ${name}. Nothing was shared and nothing was signed.` }
      : { id, name, title: "Couldn't sign in", text: m });
  }
}

/** W4: the signed-in account. */
function walletAccountView() {
  const addr = betting.address || '';
  walletShow(
    `<p class="wlabel">Wallet</p>` +
    `<div class="waddr"><code id="walletAddr" title="${esc(addr)}">${shortAddr(addr)}</code>` +
    `<button type="button" class="wcopy head" data-copy aria-label="Copy address">${SVG_COPY}</button>` +
    `<span class="devnet">DEVNET</span></div>` +
    `<p class="wnote dim" id="walletTitle">Connected with ${walletName()}</p>` +
    `<p class="wlabel">Balances</p><div id="walletTokens" class="wtokens"></div>` +
    `<p class="walleterr" id="walletErr" role="status"></p>` +
    `<div class="wfoot"><button type="button" class="wbtn ghost wcopy foot" data-copy>${SVG_COPY}Copy address</button>` +
    `<button type="button" id="walletOut" class="wbtn ghost">Disconnect</button></div>` + appearanceRow(), '#walletOut');
  $('walletOut').onclick = async () => { await signOut(); location.reload(); };
  for (const b of $('walletCard').querySelectorAll('[data-copy]')) {
    b.onclick = async () => {
      const keep = b.innerHTML;
      try { await navigator.clipboard.writeText(addr); b.classList.add('done'); if (b.classList.contains('foot')) b.innerHTML = `${SVG_COPY}Copied`; }
      catch (_) { $('walletErr').textContent = 'Copy is blocked here. Select the address and copy it.'; return; }
      walletTimers.push(setTimeout(() => { b.classList.remove('done'); b.innerHTML = keep; }, 1600));
    };
  }
  loadTokenRows();
}

const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m` : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/** Each token a round can be played in: the wallet's real balance, and (under the minimum bet) its faucet (W5). */
async function loadTokenRows() {
  const box = $('walletTokens');
  const info = await fetch('/api/chain').then(r => r.json()).catch(() => null);
  if (!box || box !== $('walletTokens')) return;          // the card moved on while this was loading
  const tokens = info && info.tokens && info.tokens.length
    ? [...info.tokens].sort((a, b) => (b.symbol === betting.token) - (a.symbol === betting.token))
    : [{ symbol: betting.currency, name: 'Test money', minBet: betting.minBet, faucet: { mode: 'none' }, demo: true }];
  box.innerHTML = tokens.map(t =>
    `<div class="tokgrp" data-t="${t.symbol}"><div class="tokrow">${glyph(t.symbol)}<span class="sym"><span class="symt">${t.symbol}` +
    (t.symbol === betting.token || t.demo ? '<em class="wtag2">THIS ROUND</em>' : '') + `<em class="wtag2 low" hidden>LOW</em></span><small>${esc(t.name)}</small></span>` +
    `<b class="bal">…</b></div><div class="faucet" hidden></div></div>`).join('');
  const faucetOf = (t) => t.faucet || { mode: 'none' };

  const paint = (t, state, d = {}) => {
    const f = box.querySelector(`[data-t="${t.symbol}"] .faucet`), fc = faucetOf(t);
    f.hidden = false; f.dataset.s = state;
    const amt = `${fmtA(fc.amount || 0)} ${t.symbol}`;
    const row = (st, sub, right) => `<span class="ftxt"><b>${t.symbol} FAUCET<em> · ${st}</em></b><small>${sub}</small></span>${right}`;
    if (state === 'idle') f.innerHTML = fc.mode === 'mint'
      ? `<span class="ftxt"><b>${t.symbol} FAUCET</b><small>${amt} per request</small></span><button type="button" class="wbtn sm" data-get>Get test token</button>`
      : `<span class="ftxt"><b>${t.symbol} FAUCET</b><small>Free devnet tokens from the token's own faucet</small></span><a class="wbtn sm" href="${fc.url}" target="_blank" rel="noopener noreferrer">Get test token ↗</a>`;
    else if (state === 'requesting') f.innerHTML = row('Requesting', `Asking the faucet for ${amt}`, `<span class="wbtn sm busy" role="status"><i class="spin" aria-hidden="true"></i>Requesting</span>`);
    else if (state === 'success') f.innerHTML = row('Received', 'Added to your balance' + (d.url ? ` · <a href="${d.url}" target="_blank" rel="noopener noreferrer">View transaction ↗</a>` : ''), `<b class="fgot">+${amt}</b>`);
    else if (state === 'cooldown') {
      f.innerHTML = row('Cooling down', fc.cooldownHours ? `One request every ${fc.cooldownHours} hour${fc.cooldownHours === 1 ? '' : 's'}` : 'One request per wallet', `<b class="fnext">Next in <span data-left></span></b>`);
      const end = Date.now() + d.ms, left = f.querySelector('[data-left]');
      const tick = () => { if (Date.now() >= end) { clearInterval(iv); paint(t, 'idle'); } else left.textContent = clock(end - Date.now()); };
      const iv = setInterval(tick, 1000); walletTimers.push(iv); tick();
    }
    else f.innerHTML = row('Request failed', esc(d.text || 'The faucet did not respond. Nothing was charged.'), `<button type="button" class="wbtn sm" data-get>Retry</button>`);
    const btn = f.querySelector('[data-get]');
    if (btn) btn.onclick = () => claim(t);
  };

  const setBal = async (t) => {
    const grp = box.querySelector(`[data-t="${t.symbol}"]`);
    const r = t.demo ? { balance: betting.balance } : await fetch(`/api/balance?token=${t.symbol}`).then(x => x.json()).catch(() => ({}));
    if (!grp) return null;
    grp.querySelector('.bal').textContent = r.balance === undefined ? '-' : fmtAmount(r.balance);
    const low = r.balance !== undefined && t.minBet != null && r.balance < t.minBet;
    grp.querySelector('.low').hidden = !(low && t.symbol === betting.token);
    // Under the minimum bet there is a way back in: show the faucet (unless it is mid-flight or just paid).
    const fc = faucetOf(t), f = grp.querySelector('.faucet');
    if (low && (fc.mode === 'mint' || (fc.mode !== 'none' && fc.url)) && f.hidden) paint(t, 'idle');
    return r.balance;
  };

  const claim = async (t) => {
    paint(t, 'requesting');
    let r, d = {};
    try { r = await fetch('/api/faucet', { method: 'POST', body: JSON.stringify({ token: t.symbol }) }); d = await r.json().catch(() => ({})); }
    catch (_) { r = null; }
    if (box !== $('walletTokens')) return;
    if (r && r.ok) {
      paint(t, 'success', { url: d.signature ? explorer(d.signature, info.cluster) : '' });
      const grp = box.querySelector(`[data-t="${t.symbol}"]`);
      if (grp && d.balance !== undefined) { grp.querySelector('.bal').textContent = fmtAmount(d.balance); grp.querySelector('.low').hidden = true; }
      if (t.symbol === betting.token && betting.refreshBalance) betting.refreshBalance();
    } else if (r && d.retryInMs) paint(t, 'cooldown', { ms: d.retryInMs });
    else paint(t, 'failed', { text: r && d.error ? d.error : '' });
  };

  for (const t of tokens) setBal(t);
}

function openWallet(err = '') {
  if (!betting.guest) walletAccountView();
  else if (typeof err === 'string' && err) {
    walletFailedView({ id: null, name: 'your wallet', title: "Couldn't connect", text: err });
  } else walletConnectView();
}
/** Backdrop tap, Escape and (on a phone) dragging the handle down close a modal card; shared by the wallet, proof and help cards. */
function sheetCard(overlay, card, close) {
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
  let d = null;
  card.addEventListener('pointerdown', (e) => {
    if (!phone.matches || !e.target.closest('.whandle')) return;
    d = { y0: e.clientY, dy: 0 };
    try { card.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (e) => {
    if (!d) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    card.style.transform = `translateY(${d.dy}px)`;
  });
  const end = () => {
    if (!d) return;
    const far = d.dy > 80; d = null;
    card.classList.remove('dragging');
    if (far) close(); else card.style.transform = '';
  };
  card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
}
sheetCard($('walletOverlay'), $('walletCard'), closeWallet);

/* ------------------------------------ tables ------------------------------------ */
//
// A table is one race loop with its own pool. The chip beside the round tag names yours; the sheet
// lists them all with the seats left, so a player can see where the people are and move.

function renderTableChip() {
  const t = betting.tableInfo, chip = $('tableChip');
  if (!NET || !t) { chip.hidden = true; return; }
  chip.hidden = false;
  $('tableChipName').textContent = t.name;
  $('tableRowTxt').textContent = t.name;
  $('ringRnd').textContent = `${t.name} · Round ${betting.round}`;
  const rule = t.minPlayers ? `needs ${t.minPlayers} players to race` : 'races every round';
  chip.title = `${t.name}: ${rule}, ${t.maxPlayers} seats, ${t.bots === 'house' ? 'with labelled house stakes' : 'players only'}. Tap to change table.`;
  chip.setAttribute('aria-label', `Table: ${t.name}. Change table`);
}

/** A message from the table: waiting for more players, a cancelled round, a move to another table. */
function onNetNotice(d) {
  if (d.kind === 'waiting' || d.kind === 'cancelled') tableNote = d;
  const secs = d.kind === 'cancelled' && d.reopensAt ? Math.min(12, Math.max(4, (d.reopensAt - betting.now()) / 1000)) : 5;
  announce(`<span class="msg">${esc(d.message)}</span>`, 'table', secs);
  $('banner').dataset.k = d.kind;
  // During betting the clock ring hangs where the banner normally sits: put the notice just below it.
  const below = Math.max($('lobby').getBoundingClientRect().bottom, $('mProof').getBoundingClientRect().bottom);
  if (below > 0 && phase === PHASE.BETTING) $('banner').style.top = `${Math.round(below + 10)}px`;
  lobbyShown = -1; dockLast = '';
  renderBetButton();
}

/** The page is moving to another table: blank it until that table's round arrives. */
function onNetSwitching(id) {
  tableNote = null;
  closeTables();
  loadingNow = true; document.body.classList.add('loading');
  $('tableChipName').textContent = betting.tableName(id);
  renderTote(); renderFeed();
}

const TABLE_PHASE = { asleep: 'QUIET', betting: 'BETTING', countdown: 'STARTING', racing: 'RACING', results: 'RESULTS' };
let tablesTimer = 0;
function renderTables() {
  const c = $('tableCard');
  if (!c || $('tableOverlay').hidden) return;
  const keep = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.table : null;
  const list = betting.tables.length ? betting.tables : [];
  const rows = list.map((t) => {
    const taken = t.maxPlayers - t.seats, full = t.seats === 0;
    if (t.disabled) {                                    // listed, not open: greyed out, cannot be chosen
      return `<button type="button" class="walletopt off" disabled aria-disabled="true">` +
        `<span class="wg" aria-hidden="true">${esc(t.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase())}</span>` +
        `<span class="wn">${esc(t.name)}<small>Players only, ${t.minPlayers} needed to race</small></span><em class="wtag2">COMING SOON</em></button>`;
    }
    const bits = [t.token || betting.currency, `${taken} of ${t.maxPlayers} seats`, t.minPlayers ? `needs ${t.minPlayers}` : t.startOn === 'bet' ? 'starts on the first bet' : t.startOn === 'player' ? 'starts when a wallet joins' : 'always races', t.bots === 'house' ? 'house stakes' : 'players only'];
    return `<button type="button" class="walletopt" data-table="${esc(t.id)}"${t.id === betting.tableId ? ' aria-current="true"' : ''}>` +
      `<span class="wg" aria-hidden="true">${esc(t.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase())}</span>` +
      `<span class="wn">${esc(t.name)}<small>${esc(bits.join(' · '))}</small></span>` +
      `<em class="wtag2${full ? ' low' : ''}">${full ? 'FULL' : (t.id === betting.tableId ? 'YOU ARE HERE' : t.waiting ? 'WAITING' : TABLE_PHASE[t.phase] || '')}</em></button>`;
  }).join('') || '<p class="wnote dim">Loading tables…</p>';
  c.innerHTML = GRAB + `<h2 class="wtitle" id="tableTitle">Choose a table</h2>` +
    `<p class="wnote">Everyone at a table watches the same race and shares one pool. A table needs its minimum number of players: short of it, the round is cancelled and every stake is returned.</p>` +
    `<div class="wlist">${rows}</div><a class="wlink" href="stats.html" target="_blank" rel="noopener">Live stats and verified rounds</a><button type="button" class="wbtn ghost" id="tableClose">Close</button>`;
  c.setAttribute('role', 'dialog'); c.setAttribute('aria-modal', 'true'); c.setAttribute('aria-labelledby', 'tableTitle');
  c.querySelectorAll('[data-table]').forEach((b) => { b.onclick = () => { if (b.dataset.table !== betting.tableId) betting.switchTable(b.dataset.table, true); else closeTables(); }; });
  $('tableClose').onclick = closeTables;
  if (keep) { const again = c.querySelector(`[data-table="${CSS.escape(keep)}"]`); if (again) try { again.focus({ preventScroll: true }); } catch (_) { /* gone */ } }
}
function openTables() {
  if (!NET) return;
  $('tableOverlay').hidden = false;
  renderTables();
  betting.refreshTables().then(renderTables);
  clearInterval(tablesTimer);
  tablesTimer = setInterval(() => betting.refreshTables().then(renderTables), 3000);
  try { $('tableCard').focus({ preventScroll: true }); } catch (_) { /* nothing */ }
}
function closeTables() { clearInterval(tablesTimer); $('tableOverlay').hidden = true; $('tableCard').style.transform = ''; }
sheetCard($('tableOverlay'), $('tableCard'), closeTables);
$('tableChip').onclick = openTables;
$('tableRow').onclick = openTables;

/* ------------------------------ the round proof card (B1 to B3) ------------------------------ */

const SVG_SHIELD = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>';
const SVG_SHIELD_OFF = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/></svg>';
const SVG_X = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const midHash = (h, a = 12, b = 4) => (h && h.length > a + b + 3 ? `${h.slice(0, a)}...${h.slice(-b)}` : h || '');

/** What Solana (or, without a chain, only the server's commitment) holds for the round on screen. */
function proofFacts() {
  const c = NET ? betting.chain : null, n = betting.round;
  const hash = betting.commitment || '', seed = betting.seed || '';
  let state = 'fixed';
  if (c && c.cluster) {
    if (c.reveal.status === 'confirmed') state = 'verified';
    else if (c.commit.status === 'confirmed') state = 'sealed';
    else if (c.commit.status === 'pending') state = 'sealing';
    else state = 'none';
  }
  return { c, n, hash, seed, state, token: betting.token || null };
}

function renderProof() {
  const { c, n, hash, seed, state, token } = proofFacts();
  const tx = (slot, later) => {
    if (!c || !c.cluster) return `<span class="v later">None</span>`;
    if (slot.status === 'confirmed' && slot.sig) return `<a class="v" href="${explorer(slot.sig, c.cluster)}" target="_blank" rel="noopener noreferrer">${midHash(slot.sig, 4, 3)} ↗</a>`;
    if (slot.status === 'pending') return `<span class="v later">Confirming…</span>`;
    return `<span class="v later">${state === 'none' ? 'None' : later}</span>`;
  };
  const head = {
    verified: [SVG_SHIELD, 'Verified on Solana', ''], sealed: [SVG_SHIELD, 'Sealed on Solana', 'SEALED'],
    sealing: [SVG_SHIELD, 'Sealing on Solana…', ''], fixed: [SVG_SHIELD, 'Fixed before betting', ''], none: [SVG_SHIELD_OFF, 'Not sealed on Solana', ''],
  }[state];
  const text = {
    verified: 'We sealed this round before betting opened. After the race we revealed the seed so anyone can replay it.',
    sealed: 'We sealed this round before betting opened. After the race we revealed the seed so anyone can replay it.',
    sealing: 'This round is being sealed on Solana. Betting opens as soon as it is sealed.',
    fixed: 'This round was fixed by the hash below before betting opened, and the seed is revealed after the race. In this mode it is not recorded on Solana.',
    none: 'This round cannot be verified on-chain. It was not sealed before betting, so bets were turned off and it runs as a watch-only race.',
  }[state];
  const copy = (val, label) => val ? `<button type="button" class="wcopy head" data-pcopy="${esc(val)}" aria-label="Copy ${label}">${SVG_COPY}</button>` : '';
  const revealSig = c && c.reveal.status === 'confirmed' ? c.reveal.sig : '';
  const row = (k, v, cp = '') => `<div class="prow"><span class="k">${k}</span>${v}${cp}</div>`;
  $('proofSheet').innerHTML = GRAB +
    `<div class="proofhead"><p class="wlabel">Round proof</p><button type="button" class="xbtn" id="proofX" aria-label="Close">${SVG_X}</button></div>` +
    `<div class="pstate${state === 'none' ? ' none' : ''}" id="proofTitle">${head[0]}${head[1]}${head[2] ? `<em class="wtag2">${head[2]}</em>` : ''}</div>` +
    `<p class="wnote">${text}</p>` +
    `<div class="prows">` +
    row('Round', `<span class="v">${n}</span>`) +
    row('Token', `<span class="v">${token || 'Demo money'}</span>`) +
    row('Commit hash', hash ? `<span class="v mono" title="${hash}">${midHash(hash)}</span>` : `<span class="v later">Not recorded</span>`, copy(hash, 'commit hash')) +
    row('Race seed', seed ? `<span class="v mono" title="${seed}">${midHash(seed, 8, 4)}</span>` : `<span class="v later">${state === 'none' ? 'Not revealed on-chain' : 'Revealed after the race'}</span>`, copy(seed, 'race seed')) +
    row('Commit tx', c && c.cluster ? tx(c.commit, 'Pending') : `<span class="v later">None</span>`) +
    row('Reveal tx', c && c.cluster ? tx(c.reveal, 'After the race') : `<span class="v later">None</span>`) +
    `</div>` +
    (state === 'none' ? '' : `<button type="button" class="wbtn dashed" id="proofReplay"${seed && hash ? '' : ' disabled'}>${seed && hash ? 'Replay it yourself' : 'Replay opens after the reveal'}</button><p class="presult" id="proofResult" role="status"></p>`) +
    (revealSig ? `<div class="pdev"><p class="wlabel">For developers</p><div class="pcmd"><code>npm run verify-round -- ${esc(revealSig)}</code>${copy(`npm run verify-round -- ${revealSig}`, 'command')}</div></div>` : '');
  $('proofX').onclick = closeProof;
  for (const b of $('proofSheet').querySelectorAll('[data-pcopy]')) {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.pcopy); b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 1400); } catch (_) { /* clipboard blocked */ }
    };
  }
  const rp = $('proofReplay');
  if (rp && !rp.disabled) rp.onclick = async () => {
    const out = $('proofResult');
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
      const got = [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
      out.textContent = got === hash
        ? 'The revealed seed hashes to the committed hash. The race you watched was run from this seed on your own screen.'
        : 'The revealed seed does NOT hash to the committed hash. Do not trust this round.';
    } catch (_) { out.textContent = 'This browser cannot compute the hash here. Use the developer command below.'; }
  };
}
function openProof() {
  renderProof();
  $('proofOverlay').hidden = false;
  const c = $('proofSheet'); c.tabIndex = -1; c.setAttribute('role', 'dialog'); c.setAttribute('aria-modal', 'true'); c.setAttribute('aria-labelledby', 'proofTitle');
  try { c.focus({ preventScroll: true }); } catch (_) { /* nothing to focus */ }
}
function closeProof() { $('proofOverlay').hidden = true; $('proofSheet').style.transform = ''; }
sheetCard($('proofOverlay'), $('proofSheet'), closeProof);

/* ------------------------------ onboarding (C1 to C5) ------------------------------ */

const HELP_SEEN = 'mr.onboarded';
let helpI = 0;
const helpArt = {
  bars: () => `<div class="hart bars" aria-hidden="true">${[['blz', 62], ['frs', 88], ['vnm', 48], ['roy', 30], ['bul', 72]].map(([k, w], i) => `<div class="hbar"><b>${i + 1}</b><i style="width:${w}%;--c:var(--m-${k})"></i></div>`).join('')}</div>`,
  clock: () => `<div class="hart clock" aria-hidden="true"><div class="hring"><b>1:00</b></div><span class="hchip">One bet · locked once sent</span></div>`,
  tiles: () => `<div class="hart" aria-hidden="true"><div class="htiles"><div class="htile">Opener</div><div class="htile">Run-in</div><div class="htile">Mempool <em>OUT</em></div></div></div>`,
  pool: () => `<div class="hart" aria-hidden="true"><div class="hpool"><div class="strip"><span class="rk">5%</span><span class="p1">1ST 75%</span><span class="p2">2ND 25%</span></div><div class="cap"><span>Rake</span><span>Backers of first</span><span>Second</span></div></div></div>`,
  tables: () => `<div class="hart" aria-hidden="true"><div class="htiles"><div class="htile">Practice<em>STARTS WHEN YOU JOIN</em></div><div class="htile off">Live<em>COMING SOON</em></div></div></div>`,
  flow: () => `<div class="hart" aria-hidden="true"><div class="hflow"><span>SEAL</span><i></i><span>RACE</span><i></i><span>REVEAL</span></div></div>`,
};
/** The smallest field a table with a minimum asks for (Live's), from the server's table list; 3 until it has been read. */
const tableMin = () => (betting.tables.find(t => t.minPlayers) || { minPlayers: 3 }).minPlayers;
function poolExample() {
  const live = betting.totalPool > 0, pool = live ? betting.totalPool : 1000, net = pool * (1 - RAKE);
  const pays = `${fmtAmount(net * PLACE_SHARES[0])} to backers of first and ${fmtAmount(net * PLACE_SHARES[1])} to backers of second, each split by stake`;
  return live ? `This round's pool of ${fmtA(pool)} ${betting.currency} would pay ${pays}.` : `Example: a pool of ${fmtA(pool)} pays ${pays}.`;
}
const HELP_ALL = [
  { t: 'Back a marble', art: 'bars', p: () => 'Pick one of five. The odds move like a tote board as money arrives, so the price you see is live until the clock ends.' },
  { t: 'Beat the clock', art: 'clock', p: () => 'Betting runs on a 60 second clock and closes 4 seconds before the gates open. One bet per round: change your marble and stake until you press Bet, then it is locked once sent. Miss the clock and you watch this race and join the next.' },
  { t: 'Pick a table', art: 'tables', net: true, p: () => `Everyone at a table watches the same race and shares one pool. Practice starts the moment a wallet joins, with labelled house stakes. Live, with players only and a minimum of ${tableMin()}, is coming soon. A full table sends you to the next one. The chip beside the round number switches tables.` },
  { t: 'Every course is new', art: 'tiles', p: () => 'Each race is built fresh from over a hundred sections, about 3 to 4 minutes long. Machines are toughest on whoever reaches them first and chaos hits everyone alike. Knockouts are rare, at most two a race, so both paid places always go to finishers.' },
  { t: 'Top two are paid', art: 'pool', p: () => `After a ${Math.round(RAKE * 100)}% rake, 75% of your table's pool goes to backers of first place and 25% to backers of second. A heavily backed marble pays less even when it wins.`, ex: poolExample },
  { t: 'Provably fair', art: 'flow', p: () => 'Every round is fixed by a hash before betting opens and revealed after the race, so anyone can replay it. On devnet rounds that hash is sealed on Solana.', note: true },
];
/** The tour: the table step only on a page served by the round server (the local demo has no tables). */
const helpSteps = () => HELP_ALL.filter(s => !s.net || NET);
function renderHelp(dir) {
  const HELP_STEPS = helpSteps();
  const st = HELP_STEPS[helpI], last = helpI === HELP_STEPS.length - 1;
  $('helpCard').innerHTML = GRAB +
    `<div class="hmeta"><p class="wlabel">${helpI + 1} of ${HELP_STEPS.length}</p>${last ? '' : '<button type="button" class="hskip" id="helpSkip">Skip</button>'}</div>` +
    `<div class="hslide${dir < 0 ? ' back' : ''}">${helpArt[st.art]()}<div class="hbody"><p class="wlabel">How it works</p><h2 id="helpTitle">${st.t}</h2><p>${st.p()}</p>` +
    (st.ex ? `<p class="ex">${st.ex()}</p>` : '') +
    (st.note ? `<p class="hnote"><span class="devnet">DEVNET</span>Devnet test money. No real funds.</p>` + appearanceRow() : '') + `</div></div>` +
    `<div class="hdots" aria-hidden="true">${HELP_STEPS.map((_, i) => `<i class="${i === helpI ? 'on' : ''}"></i>`).join('')}</div>` +
    `<div class="hnav">${helpI ? '<button type="button" class="wbtn ghost" id="helpBack">Back</button>' : ''}` +
    (last ? '<button type="button" class="wbtn" id="helpClose">Got it</button>' : '<button type="button" class="wbtn" id="helpNext">Next</button>') + `</div>`;
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('helpNext', () => { helpI++; renderHelp(1); $('helpNext')?.focus(); $('helpClose')?.focus(); });
  on('helpBack', () => { helpI--; renderHelp(-1); $('helpNext')?.focus(); $('helpClose')?.focus(); });
  on('helpSkip', closeHelp);
  on('helpClose', closeHelp);
}
function openHelp(step = 0) {
  helpI = step; renderHelp(1);
  $('helpOverlay').hidden = false;
  const c = $('helpCard'); c.tabIndex = -1; c.setAttribute('role', 'dialog'); c.setAttribute('aria-modal', 'true'); c.setAttribute('aria-labelledby', 'helpTitle');
  try { $('helpNext').focus({ preventScroll: true }); } catch (_) { /* nothing to focus */ }
}
function closeHelp() {
  $('helpOverlay').hidden = true; $('helpCard').style.transform = '';
  let first = false;
  try { first = !localStorage.getItem(HELP_SEEN); localStorage.setItem(HELP_SEEN, '1'); } catch (_) { /* private mode: it will show again, that is fine */ }
  if (first && !reducedMotion()) { const b = $('helpBtn'); b.classList.add('helppulse'); setTimeout(() => b.classList.remove('helppulse'), 1300); }
}
sheetCard($('helpOverlay'), $('helpCard'), closeHelp);
$('helpBtn').onclick = () => openHelp(0);
// First visit: the stepper opens once by itself.
try { if (!localStorage.getItem(HELP_SEEN)) setTimeout(() => { if ($('walletOverlay').hidden && $('proofOverlay').hidden && $('tableOverlay').hidden) openHelp(0); }, 700); } catch (_) { /* no storage: no auto-open */ }


buildCamBar();
$('camToggle').onclick = () => {
  const card = $('camCard'), open = card.classList.toggle('collapsed') === false;
  $('camToggle').setAttribute('aria-expanded', open);
  $('camToggle').setAttribute('aria-label', open ? 'Collapse side cam' : 'Expand side cam');
};

// Boot: a server round if the page came from the round server, else local.
(async () => {
  if (await detectServer()) {
    NET = true;
    document.body.classList.add('net', 'loading');
    loadingNow = true; renderTote(); renderFeed();
    betting = new RemoteBetting({
      round: onNetRound,
      pool: () => { renderTote(); renderFeed(); if (phase === PHASE.READY) renderBetButton(); },
      sync: onNetSync,
      settled: onNetSettled,
      hello: renderAccount,
      payout: () => renderResultLinks(),
      chain: () => { renderFair(); renderTote(); if (phase === PHASE.BETTING) renderBetButton(); },
      status: onNetStatus,
      changed: () => { renderTote(); renderWallet(); renderStakes(); renderBetButton(); },
      error: (msg) => announce(`<span class="msg">${esc(msg)}</span>`, 'out'),
      betFailed: onBetFailed,
      notice: onNetNotice,
      switching: onNetSwitching,
    });
  } else newRound();
  requestAnimationFrame(frame);
})();

// Small debug surface, same idea as the 3D build's window.__marblerush.
window.__mr2d = {
  sfx,
  get phase() { return phase; },
  get result() { return result; },
  get engine() { return engine; },
  get track() { return track; },
  betting, get renderer() { return renderer; },
  get lobby() { return lobby; },
  get net() { return NET; },
  get drift() { return { mine: Object.fromEntries(mySecond), server: Object.fromEntries(srvSecond) }; },
  get netRound() { return netRound; },
  get tableNote() { return tableNote; },
  get bettingLive() { return betting; },
  pause(on = true) { paused = on; },
  /** Run `n` frames by hand (16.7 ms each), for when the pane is hidden and the browser has paused requestAnimationFrame. */
  pump(n = 1, ms = 1000 / 60) {
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;                 // the real loop re-arms itself when the pane shows again
    try { let t = performance.now(); for (let i = 0; i < n; i++) { t += ms; frame(t); } } finally { window.requestAnimationFrame = raf; }
  },
  /** Redraw the market and dock after poking `bettingLive` by hand (to look at every dock state), and fake a failed bet. */
  render() { renderTote(); },
  fail(msg = 'Bet cancelled in the wallet') { onBetFailed(msg); },
  /** Re-draw the result screen with part of the settlement overridden, to look at every outcome (win, place, loss, void). */
  settle(patch = {}) { if (phase !== PHASE.FINISHED) return; settleInfo = { ...settleInfo, ...patch }; showResult(); },
  skip() { if (phase === PHASE.BETTING) { betting.placeBet(); enterCountdown(); } },
  ready() { if (phase === PHASE.BETTING) { betting.placeBet(); enterReady(); } },
  /** Wind the lobby clock down to `secs`, for testing the expiry path. */
  clock(secs = 0.05) { lobby = secs; lobbyShown = -1; },
};

/* --------------------------------- sound --------------------------------- */

const SPEAKER_ON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
const SPEAKER_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
function renderSoundBtn() {
  const b = $('soundBtn'), off = sfx.muted;
  b.innerHTML = off ? SPEAKER_OFF : SPEAKER_ON;
  b.setAttribute('aria-pressed', String(!off));
  b.title = off ? 'Sound is off: turn it on' : 'Sound is on: mute';
  b.setAttribute('aria-label', off ? 'Turn sound on' : 'Mute sound');
}
$('soundBtn').onclick = () => sfx.toggle();
sfx.onChange(renderSoundBtn);
renderSoundBtn();
document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button'); if (b && b.id !== 'soundBtn' && !b.disabled) sfx.play('click'); }, true);
