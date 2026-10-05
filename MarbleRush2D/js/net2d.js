// net2d.js: The browser's side of a server round.
//
// When the page is served by server/server.mjs the round is not ours: the
// server runs the lobby clock, holds the pool and every bet, decides the race
// and pays out. This module keeps a live mirror of that over Server-Sent
// Events and exposes it with the SAME surface as BettingManager, so the rest
// of the page (tote board, feed, wallet, history) does not care where the
// numbers come from.
//
// It never decides anything. A bet is a request; the pool changes when the
// server says it did.

import { MARBLE_DATA } from '../../js/racers.js';
import { PLACE_SHARES, RAKE, MIN_BET, STARTING_BALANCE } from '../../js/betting.js';

const K = MARBLE_DATA.length;
const PID_KEY = 'marblerush.pid';

/** Is this page being served by the round server? */
export async function detectServer() {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    return r.ok && (await r.json()).marblerush === true;
  } catch { return false; }
}

function playerId() {
  let id = null;
  try { id = localStorage.getItem(PID_KEY); } catch { /* private mode */ }
  if (!id || !/^[a-z0-9]{8,40}$/i.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(PID_KEY, id); } catch { /* fine, this tab only */ }
  }
  return id;
}

export class RemoteBetting {
  /** `on` receives { hello, round, pool, sync, settled } callbacks. */
  constructor(on) {
    this.pid = playerId();
    this.on = on;
    this.remote = true;

    this.balance = STARTING_BALANCE;
    this.history = [];
    this.stats = { races: 0, wins: 0, wagered: 0, returned: 0, best: 0, streak: 0, bestStreak: 0 };
    this.round = 0;
    this.seed = '';
    this.commitment = '';
    this.pools = new Array(K).fill(0);
    this.backers = new Array(K).fill(0);
    this.bots = [];                 // every bet on the board that is not ours: the feed
    this.pendingBots = [];          // the server reveals backers; nothing queued here
    this.selected = -1;
    this.stakePref = 50;
    try { this.stakePref = +(localStorage.getItem('marblerush.stake') || 50); } catch { /* */ }
    this.stake = this.stakePref;
    this.placed = false;
    this.ready = 0;
    this.players = 1;
    this.settled = null;
    this.offsets = [];              // server clock minus ours, per message
    this.connect();
  }

  /* ------------------------------- clock ------------------------------- */

  /** The server's clock, from ours. Latency only ever makes a sample SMALLER
   *  than the true offset, so the largest recent sample is the best guess. */
  now() { return Date.now() + (this.offsets.length ? Math.max(...this.offsets) : 0); }
  _clock(serverNow) {
    if (!serverNow) return;
    this.offsets.push(serverNow - Date.now());
    if (this.offsets.length > 20) this.offsets.shift();
  }

  /* ---------------------------- connection ----------------------------- */

  connect() {
    const es = new EventSource(`/api/events?pid=${this.pid}`);
    this.es = es;
    const on = (type, fn) => es.addEventListener(type, (e) => { const d = JSON.parse(e.data); this._clock(d.now); fn(d); });
    on('hello', (d) => {
      this.balance = d.balance; this.history = d.history; this.stats = d.stats;
      this.name = d.name;
      this.checkPrint(d.print);
      this.on.hello?.(d);
    });
    on('round', (d) => { this._round(d); this.on.round?.(d); });
    on('pool', (d) => { if (d.id === this.round) { this._pool(d); this.on.pool?.(d); } });
    on('sync', (d) => this.on.sync?.(d));
    on('settled', (d) => {
      this.balance = d.balance; this.history = d.history; this.stats = d.stats;
      this.settled = d;
      this.on.settled?.(d);
    });
    es.onerror = () => this.on.status?.('reconnecting');
    es.onopen = () => this.on.status?.('live');
  }

  /**
   * Can this browser replay the server's races? It races a short fixed
   * course and compares the hash with the server's. A mismatch means
   * different code (the server was updated, this tab has the old copy) or a
   * JavaScript engine that computes differently: reload once for fresh code;
   * if it still differs, say so rather than show a race that is not the one
   * being paid on.
   */
  async checkPrint(serverPrint) {
    if (!serverPrint) return;
    const { buildPrint } = await import('./detcheck.js');
    const mine = buildPrint();
    this.printOk = mine === serverPrint;
    if (this.printOk) { try { sessionStorage.removeItem('marblerush.reloaded'); } catch { /* */ } return; }
    console.error('[race] this browser races differently from the server', { mine, server: serverPrint });
    let tried = false;
    try { tried = sessionStorage.getItem('marblerush.reloaded') === serverPrint; sessionStorage.setItem('marblerush.reloaded', serverPrint); } catch { /* */ }
    if (!tried) location.reload();
    else this.on.error?.('This browser cannot replay the live race exactly. Results still come from the server.');
  }

  _round(d) {
    if (d.id !== this.round) {
      this.round = d.id;
      this.selected = -1;
      this.placed = false;
      this.settled = null;
      this.stake = Math.min(this.stakePref, Math.max(MIN_BET, Math.floor(this.balance)));
    }
    this.seed = d.raceSeed || '';
    this.commitment = d.commitment;
    this._pool(d);
  }

  _pool(d) {
    this.pools = d.pools.slice();
    this.backers = d.backers.slice();
    this.bots = d.bets.map(b => ({ ...b, mine: b.handle === this.name, handle: b.handle === this.name ? 'you' : b.handle }));
    this.ready = d.ready;
    this.players = d.players;
  }

  async _post(path, body) {
    const r = await fetch(`/api/${path}?pid=${this.pid}`, { method: 'POST', body: JSON.stringify(body || {}) });
    return { ok: r.ok, body: await r.json().catch(() => ({})) };
  }

  /* -------------------- the BettingManager surface -------------------- */

  get totalPool() { return this.pools.reduce((a, b) => a + b, 0); }
  get netPool() { return this.totalPool * (1 - RAKE); }
  get maxStake() { return Math.floor(this.balance); }
  get netProfit() { return this.stats.returned - this.stats.wagered; }
  get winRate() { return this.stats.races ? this.stats.wins / this.stats.races : 0; }

  oddsFor(idx, place = 0) {
    const on = this.pools[idx];
    if (on <= 0 || !PLACE_SHARES[place]) return null;
    return (this.netPool * PLACE_SHARES[place]) / on;
  }

  quote(idx, stake) {
    const pool = this.totalPool + stake, on = this.pools[idx] + stake, net = pool * (1 - RAKE);
    const at = (p) => (stake / on) * net * (PLACE_SHARES[p] || 0);
    return { payout: at(0), profit: at(0) - stake, odds: at(0) / stake, place: at(1), placeOdds: at(1) / stake, pool };
  }

  canAfford(v) { return v >= MIN_BET && v <= this.balance; }
  select(i) { this.selected = i; }
  setStake(v) {
    this.stake = Math.max(MIN_BET, Math.min(this.maxStake, Math.round(v)));
    this.stakePref = this.stake;
    try { localStorage.setItem('marblerush.stake', String(this.stake)); } catch { /* */ }
    return this.stake;
  }

  /** Ask the server for the bet. Optimistic: the board updates when it says so. */
  placeBet() {
    if (this.placed || this.selected < 0 || !this.canAfford(this.stake)) return false;
    this.placed = true;
    this.balance -= this.stake;
    const marble = this.selected, amount = this.stake;
    this._post('bet', { marble, amount }).then(({ ok, body }) => {
      if (ok) { this.balance = body.balance; }
      else { this.placed = false; this.balance += amount; this.on.error?.(body.error || 'bet refused'); }
      this.on.changed?.();
    });
    return true;
  }

  sendReady() { return this._post('ready'); }
  topUp() { this._post('topup').then(({ ok, body }) => { if (ok) this.balance = body.balance; this.on.changed?.(); }); return this.balance; }

  // The server does all of these; they exist so the page can call them.
  newRound() { return this.seed; }
  revealBot() { return null; }
  revealAllBots() {}
  autoBetPending() { return []; }
  autoBetPlayer() { return null; }

  /** This player's settlement, in the shape the result card reads. */
  settle() {
    const s = this.settled, you = s && s.you;
    if (!you) return { void: false, place: -1, backed: -1, stake: 0, profit: 0, odds: 0, pending: !s };
    return { void: you.void, place: you.place, backed: you.backed, stake: you.stake, profit: you.profit,
             payout: you.payout, odds: you.odds, won: you.won };
  }
}
