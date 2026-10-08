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
import { PLACE_SHARES, RAKE, MIN_BET, CURRENCY } from '../../js/betting.js';
import { signBet } from './wallet2d.js';

const K = MARBLE_DATA.length;

/** Is this page being served by the round server? */
export async function detectServer() {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    return r.ok && (await r.json()).marblerush === true;
  } catch { return false; }
}

export class RemoteBetting {
  /** `on` receives { hello, round, pool, sync, settled } callbacks. */
  constructor(on) {
    this.on = on;
    this.remote = true;

    this.guest = true;              // until the server says who we are
    this.address = '';
    this.balance = 0;
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
    this.chains = new Map();        // round id -> what is on Solana for it
    this.payouts = new Map();       // round id -> { status, sigs }
    this.token = null;              // the round's token symbol; null: server demo money
    this.minBetV = MIN_BET;
    this.tokenMeta = {};            // symbol -> { stakes, minBet, decimals } from /api/chain
    this.betState = 'idle';         // idle | preparing | signing | confirming
    this.tableId = '';              // the table this page is seated at ('live', 'live-2', ...)
    this.family = '';
    this.tableInfo = null;          // { id, name, minPlayers, maxPlayers, bots } from the round
    this.real = 0;                  // wallets that have bet at this table this round
    this.tables = [];               // every table, from /api/tables (refreshTables)
    this._retry = 0;
    fetch('/api/chain').then(r => r.json()).then(i => { for (const t of i.tokens) this.tokenMeta[t.symbol] = t; this.cluster = i.cluster; this.on.changed?.(); }).catch(() => {});
    this.offsets = [];              // server clock minus ours, per message
    this.refreshTables();           // the tour and the picker read the table list
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

  /**
   * Seat this page at a table. `table` is a family ("live": the busiest one with room) or, with `pin`,
   * exactly one table ("live-2"). The first visit asks for the stored or ?table= family, else the server's default.
   */
  connect(table = this._wantTable(), pin = false) {
    const q = table ? `?table=${encodeURIComponent(table)}${pin ? '&pin=1' : ''}` : '';
    const es = new EventSource('/api/events' + q);   // the session cookie says who we are
    this.es = es;
    const on = (type, fn) => es.addEventListener(type, (e) => { const d = JSON.parse(e.data); this._clock(d.now); fn(d); });
    on('hello', (d) => {
      this.guest = !!d.guest;
      this.address = d.pid || '';
      if (!d.onchain) this.balance = d.balance;
      this.history = d.history; this.stats = d.stats || this.stats;
      this.name = d.name;
      this.tableId = d.table || ''; this.family = d.family || '';
      if (this.family) { try { localStorage.setItem('marblerush.table', this.family); } catch { /* */ } }
      this.checkPrint(d.print, d.code);
      this.on.hello?.(d);
    });
    on('notice', (d) => { if (d.id === this.round) this.on.notice?.(d); });
    on('round', (d) => { this._round(d); this.on.round?.(d); });
    on('pool', (d) => { if (d.id === this.round) { this._pool(d); this.on.pool?.(d); } });
    on('sync', (d) => this.on.sync?.(d));
    on('payout', (d) => {
      this.payouts.set(d.id, d);
      if (d.status === 'confirmed') this.refreshBalance();
      this.on.payout?.(d);
    });
    on('chain', (d) => {
      this.chains.set(d.id, d);
      for (const k of this.chains.keys()) if (k < d.id - 4) this.chains.delete(k);
      this.on.chain?.(d);
    });
    on('settled', (d) => {
      if (d.balance !== undefined) this.balance = d.balance;
      this.history = d.history; this.stats = d.stats;
      this.settled = d;
      this.on.settled?.(d);
    });
    // Our own reconnect, so a dropped link comes back to the SAME table instead of wherever the browser's retry lands.
    es.onerror = () => {
      this.on.status?.('reconnecting');
      if (this.es !== es) return;
      es.close();
      const n = ++this._retry, id = this.tableId;
      setTimeout(() => {
        if (this.es !== es) return;
        // twice failing to find our table (it closed while we were away): its family, then the server's choice
        if (id && n <= 2) this.connect(id, true);
        else if (this.family && n <= 4) this.connect(this.family, false);
        else this.connect('', false);
      }, Math.min(5000, 800 * n));
    };
    es.onopen = () => { this._retry = 0; this.on.status?.('live'); };
  }

  _wantTable() {
    try {
      const q = new URLSearchParams(location.search).get('table');
      return q || localStorage.getItem('marblerush.table') || '';
    } catch { return ''; }
  }

  /** Move to another table (the page resets as the new table's round arrives). */
  switchTable(id, pin = true) {
    if (!id || (pin && id === this.tableId)) return;
    if (this.es) { const old = this.es; this.es = null; old.close(); }
    this.tableId = id; this._retry = 0;
    this.round = 0; this.selected = -1; this.placed = false; this.settled = null; this.betState = 'idle'; this._cancel = null;
    this.pools = new Array(K).fill(0); this.backers = new Array(K).fill(0); this.bots = []; this.real = 0; this.tableInfo = null;
    this.on.switching?.(id);
    this.connect(id, pin);
  }

  /** Every table, for the picker. */
  async refreshTables() {
    try {
      const r = await fetch('/api/tables', { cache: 'no-store' });
      if (r.ok) this.tables = (await r.json()).tables;
    } catch { /* keep the last list */ }
    return this.tables;
  }

  /** "live-2" as people read it. */
  tableName(id) {
    const t = this.tables.find(x => x.id === id);
    if (t) return t.name;
    return id.replace(/-(\d+)$/, ' $1').replace(/^./, c => c.toUpperCase());
  }

  /** A "table is full" answer carries where to go: say so, and go. */
  _full(body) {
    if (!body || !body.full) return false;
    if (body.move) {
      const to = this.tableName(body.move);
      setTimeout(() => { this.on.notice?.({ kind: 'moved', message: `That table is full. Moved you to ${to}.` }); this.switchTable(body.move, true); }, 0);
    }
    return true;
  }

  /**
   * Can this browser replay the server's races? It races a short fixed
   * course and compares the hash with the server's. A mismatch means
   * different code (the server was updated, this tab has the old copy) or a
   * JavaScript engine that computes differently: reload once for fresh code;
   * if it still differs, say so rather than show a race that is not the one
   * being paid on.
   */
  async checkPrint(serverPrint, serverCode) {
    if (!serverPrint) return;
    const { buildPrint } = await import('./detcheck.js');
    const mine = buildPrint();
    // Same source as the server started with? (The print above only covers the rules one fixed course uses.)
    let sourceOk = true;
    if (serverCode && serverCode.hash && crypto.subtle) {
      try {
        const enc = new TextEncoder(), parts = [];
        for (const f of serverCode.files) {
          const bytes = new Uint8Array(await (await fetch('/' + f, { cache: 'no-store' })).arrayBuffer());
          parts.push(enc.encode(f + '\0'), bytes, enc.encode('\0'));
        }
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
        const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', all)), b => b.toString(16).padStart(2, '0')).join('');
        sourceOk = hex.slice(0, 16) === serverCode.hash;
        if (!sourceOk) console.error('[race] the game code on the server changed since it started: restart the server', { served: hex.slice(0, 16), running: serverCode.hash });
      } catch { /* offline hiccup: the print still guards */ }
    }
    this.printOk = mine === serverPrint && sourceOk;
    if (!this.printOk && mine === serverPrint) { this.on.error?.('The game was updated while you were playing. Reload the page.'); return; }
    if (this.printOk) { try { sessionStorage.removeItem('marblerush.reloaded'); } catch { /* */ } return; }
    console.error('[race] this browser races differently from the server', { mine, server: serverPrint });
    let tried = false;
    try { tried = sessionStorage.getItem('marblerush.reloaded') === serverPrint; sessionStorage.setItem('marblerush.reloaded', serverPrint); } catch { /* */ }
    if (!tried) location.reload();
    else this.on.error?.('This browser cannot replay the live race exactly. Results still come from the server.');
  }

  /** Stake sizes for this round: the token's, or the demo defaults. */
  get stakes() { return (this.token && this.tokenMeta[this.token]?.stakes) || [10, 25, 50, 100]; }
  get minBet() { return this.token ? (this.tokenMeta[this.token]?.minBet ?? this.minBetV) : MIN_BET; }
  get currency() { return this.token || CURRENCY; }

  /** The wallet's real balance of this round's token, read from Solana by the server. */
  async refreshBalance() {
    if (this.guest || !this.token) return;
    if (this._balBusy) { this._balAgain = true; return; }     // one request at a time; ask again after it
    this._balBusy = true;
    try {
      const sym = this.token;
      const r = await fetch(`/api/balance?token=${sym}`).then(x => x.ok ? x.json() : null).catch(() => null);
      if (r && sym === this.token) { this.balance = r.balance; this.on.changed?.(); }
    } finally {
      this._balBusy = false;
      if (this._balAgain) { this._balAgain = false; this.refreshBalance(); }
    }
  }

  _round(d) {
    if (d.id !== this.round) {
      this.round = d.id;
      this.selected = -1;
      this.placed = false;
      this.settled = null;
      this.token = d.token || null;
      this.minBetV = d.minBet || MIN_BET;
      const st = this.stakes;
      this.stake = st.includes(this.stakePref) ? this.stakePref : st[Math.min(1, st.length - 1)];
      if (this.token) this.refreshBalance();
    }
    this.seed = d.raceSeed || '';
    this.commitment = d.commitment;
    this.tableInfo = d.table || this.tableInfo;
    this._pool(d);
  }

  _pool(d) {
    this.pools = d.pools.slice();
    this.backers = d.backers.slice();
    this.bots = d.bets.map(b => ({ ...b, mine: b.handle === this.name, handle: b.handle === this.name ? 'you' : b.handle }));
    this.ready = d.ready;
    this.players = d.players;
    if (d.real !== undefined) this.real = d.real;
  }

  async _post(path, body) {
    const r = await fetch(`/api/${path}`, { method: 'POST', body: JSON.stringify({ table: this.tableId || undefined, ...(body || {}) }) });
    return { ok: r.ok, body: await r.json().catch(() => ({})) };
  }

  /* -------------------- the BettingManager surface -------------------- */

  /** What Solana holds for the round on screen: { cluster, token, commit, reveal } or null. */
  get chain() { return this.chains.get(this.round) || null; }
  /** True while the commit is on its way: the server refuses bets until it lands. */
  get sealing() { return this.chain?.commit.status === 'pending'; }

  get totalPool() { return this.pools.reduce((a, b) => a + b, 0); }
  get netPool() { return this.totalPool * (1 - RAKE); }
  get maxStake() { return Math.floor(this.balance * 100) / 100; }
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

  canAfford(v) { return !this.guest && v >= this.minBet - 1e-9 && v <= this.balance + 1e-9; }
  select(i) { if (this.placed || this.betState !== 'idle') return; this.selected = i; }
  setStake(v) {
    if (this.placed || this.betState !== 'idle') return this.stake;
    this.stake = Math.max(this.minBet, Math.min(this.maxStake, Math.round(v * 100) / 100));
    this.stakePref = this.stake;
    try { localStorage.setItem('marblerush.stake', String(this.stake)); } catch { /* */ }
    return this.stake;
  }

  /** Ask the server for the bet. Optimistic: the board updates when it says so. */
  placeBet() {
    if (this.guest || this.placed || this.selected < 0 || this.betState !== 'idle' || !this.canAfford(this.stake)) return false;
    if (this.token) { this._placeSigned(this.selected, this.stake); return true; }
    this.placed = true;
    this.balance -= this.stake;
    const marble = this.selected, amount = this.stake;
    this._post('bet', { marble, amount }).then(({ ok, body }) => {
      if (ok) { this.balance = body.balance; }
      else { this.placed = false; this.balance += amount; this._betFailed(body.error || 'bet refused'); this._full(body); }
      this.on.changed?.();
    });
    return true;
  }

  /**
   * A bet in real tokens: the server builds a transaction (stake into the vault, a memo naming the
   * round and marble, the server paying the fee), the wallet signs it, the server sends it and
   * waits for Solana. The bet exists once it has landed; until then nothing is on the board.
   */
  async _placeSigned(marble, amount) {
    const fail = (msg) => { this.betState = 'idle'; this._cancel = null; this._betFailed(msg); this.on.changed?.(); this.refreshBalance(); };
    try {
      this.betState = 'preparing'; this.on.changed?.();
      const prep = await this._post('bet/prepare', { marble, amount });
      if (!prep.ok) { fail(prep.body.error || 'bet refused'); this._full(prep.body); return; }
      this.betState = 'signing'; this.on.changed?.();
      // Cancel in the page abandons the wait; nothing was sent, so a late approval in the wallet is harmless.
      const cancelled = new Promise((_, no) => { this._cancel = () => no(new Error('Bet cancelled')); });
      const tx = await Promise.race([signBet(this.address, prep.body.tx), cancelled]);
      this._cancel = null;
      this.betState = 'confirming'; this.on.changed?.();
      const sent = await this._post('bet/submit', { prepId: prep.body.prepId, tx });
      if (!sent.ok) return fail(sent.body.error || 'the bet did not go through');
      this.placed = true; this.betState = 'idle'; this.lastBetSig = sent.body.signature;
      this.balance = Math.max(0, this.balance - amount);
      this.on.changed?.(); this.refreshBalance();
    } catch (e) { fail(e.message || 'the bet did not go through'); }
  }

  /** A bet that did not go through (declined, cancelled, refused): the page shows it in the dock. */
  _betFailed(msg) { (this.on.betFailed || this.on.error)?.(msg); }
  /** Give up waiting for the wallet (only while it is open for signing). */
  cancelBet() { if (this.betState !== 'signing' || !this._cancel) return false; this._cancel(); return true; }

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
