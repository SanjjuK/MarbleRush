// betting.js: Parimutuel pool engine.
//
// Every stake on a race goes into one pool. The house takes a rake, and what is
// left is split between everyone who backed the winner, in proportion to their
// stake. Odds are therefore not fixed: they move as money arrives, exactly like
// a tote board.
//
//   netPool  = totalPool * (1 - rake)
//   odds(i)  = netPool / poolOn(i)          (decimal, stake included)
//   payout   = yourStake * odds(winner)
//
// Everything here is demo money held in localStorage. No chain, no custody.

import { MARBLE_DATA } from './racers.js';
import { makeRng, generateSeed, seedCommitment } from './rng.js';

/**
 * How the net pool is split between finishing positions.
 *
 * A parimutuel pool CANNOT promise a fixed multiple, "third place gets their
 * stake back" is a 1.0x promise, and if enough money sits on the marble that
 * finishes third there is not enough pot to honour it. A tote splits a fixed
 * pot into shares; the multiple that produces then floats with the money, which
 * is correct and is why tote odds move.
 *
 * Two places from five runners is the conventional shape (real racing pays a
 * third place only with eight or more runners). At roughly even money this
 * gives about 3.6x for the winner and 1.2x for the runner-up.
 */
export const PLACE_SHARES = [0.75, 0.25];

export const CURRENCY   = 'USDC';
export const RAKE       = 0.05;
export const MIN_BET    = 5;
export const STARTING_BALANCE = 1000;

const STORAGE_KEY = 'marblerush.v2';

const BOT_HANDLES = [
  'degen.eth', 'marblemaxi', '0x9f…4c21', 'rollie.eth', 'sats_only',
  'vault_ape', '0x3b…88af', 'chalkline', 'lp_sniper', 'tungsten.eth',
  'chuteclub', '0xd2…1e07', 'roundabout', 'basedbets', 'nonce.eth',
  'slipstream', '0x71…9b40', 'oracle_tom', 'gwei_wizard', 'banked.eth',
];

export class BettingManager {
  constructor() {
    const saved = this._load();

    this.balance   = saved.balance ?? STARTING_BALANCE;
    this.round     = saved.round ?? 1;
    this.history   = saved.history ?? [];       // most recent first
    this.stats     = Object.assign(
      { races: 0, wins: 0, wagered: 0, returned: 0, best: 0, streak: 0, bestStreak: 0 },
      saved.stats || {}
    );
    this.form = saved.form ?? MARBLE_DATA.map(() => 0);   // all-time wins per racer

    this.seed = '';
    this.commitment = '';
    this.pools = MARBLE_DATA.map(() => 0);
    this.backers = MARBLE_DATA.map(() => 0);
    this.bots = [];
    this.pendingBots = [];
    this.selected = -1;
    // The chosen stake is a PREFERENCE that outlives the round. `stake` is what
    // is actually on the board and the auto-bet overwrites it with the minimum,
    // so without a separate preference one timed-out round would quietly reset
    // the player's stake button to 5 for every round after it.
    this.stakePref = saved.stakePref ?? 50;
    this.stake = this.stakePref;
    this.placed = false;
  }

  /* ================= round lifecycle ================= */

  /**
   * Open a round. `seed` is a DEVELOPMENT hook for replaying a known race; the
   * page only passes one on localhost, because a player who can choose the
   * seed can choose the winner.
   */
  newRound(seed) {
    this.seed = seed || generateSeed();
    this.commitment = seedCommitment(this.seed);
    this.rng = makeRng(this.seed);

    this.pools = MARBLE_DATA.map(() => 0);
    this.backers = MARBLE_DATA.map(() => 0);
    this.bots = [];
    this.selected = -1;
    this.placed = false;
    this.stake = Math.min(this.stakePref, Math.max(MIN_BET, this.balance));

    this.pendingBots = this._generateBots();
    return this.seed;
  }

  _generateBots() {
    const rng = this.rng;
    const count = rng.int(7, 11);

    // Give each racer a random "market appetite" so the tote board is uneven.
    const appetite = MARBLE_DATA.map(() => 0.35 + rng() * 1.5);
    const total = appetite.reduce((a, b) => a + b, 0);

    const handles = BOT_HANDLES.slice();
    const bots = [];

    for (let i = 0; i < count; i++) {
      const h = handles.splice(rng.int(0, handles.length - 1), 1)[0];

      // Weighted pick
      let r = rng() * total, idx = 0;
      for (let k = 0; k < appetite.length; k++) {
        r -= appetite[k];
        if (r <= 0) { idx = k; break; }
      }

      // Mostly small stakes, occasionally a whale
      const whale = rng() < 0.14;
      const amount = whale
        ? Math.round(rng.range(150, 420) / 10) * 10
        : Math.round(rng.range(10, 110) / 5) * 5;

      bots.push({ handle: h, marble: idx, amount, whale });
    }
    return bots;
  }

  /** Move the next queued bot onto the board. Returns the bot, or null. */
  revealBot() {
    if (!this.pendingBots.length) return null;
    const bot = this.pendingBots.shift();
    this.bots.push(bot);
    this.pools[bot.marble] += bot.amount;
    this.backers[bot.marble] += 1;
    return bot;
  }

  revealAllBots() {
    while (this.pendingBots.length) this.revealBot();
  }

  /* ================= tote board maths ================= */

  get totalPool() {
    return this.pools.reduce((a, b) => a + b, 0);
  }

  get netPool() {
    return this.totalPool * (1 - RAKE);
  }

  get rakeAmount() {
    return this.totalPool * RAKE;
  }

  /** Decimal odds for a racer, as the board stands right now. */
  /**
   * Shares actually payable, given who has money on them.
   *
   * A position nobody backed has no claimants, so its share is redistributed
   * across the positions that do have backers rather than being kept by the
   * house. Only if NO paying position was backed at all is the round void.
   */
  payableShares(order) {
    const shares = PLACE_SHARES.map((s, i) =>
      (order[i] !== undefined && this.pools[order[i]] > 0) ? s : 0);
    const live = shares.reduce((a, b) => a + b, 0);
    return live > 0 ? shares.map(s => s / live) : null;
  }

  /**
   * Decimal odds for finishing in `place` (0 = win, 1 = runner-up).
   *
   * These are the NOMINAL odds, what this position pays if every paying
   * position has backers. If one does not, its share is redistributed at
   * settlement and the real payout comes out higher, never lower.
   */
  oddsFor(idx, place = 0) {
    const on = this.pools[idx];
    if (on <= 0) return null;                 // no money on it yet
    const share = PLACE_SHARES[place];
    if (!share) return null;
    return (this.netPool * share) / on;
  }

  /** What the board would pay if `stake` went on `idx` and it won. */
  quote(idx, stake) {
    const pool = this.totalPool + stake;
    const on = this.pools[idx] + stake;
    const net = pool * (1 - RAKE);
    const at = (place) => (stake / on) * net * (PLACE_SHARES[place] || 0);
    const payout = at(0);
    return {
      payout,
      profit: payout - stake,
      odds: payout / stake,
      // What the same stake returns if it only places. Shown next to the win
      // quote so a backer can see the downside is not a total loss.
      place: at(1),
      placeOdds: at(1) / stake,
      pool,
    };
  }

  get maxStake() {
    return Math.floor(this.balance);
  }

  canAfford(amount) {
    return amount >= MIN_BET && amount <= this.balance;
  }

  select(idx) { this.selected = idx; }

  setStake(v) {
    this.stake = Math.max(MIN_BET, Math.min(this.maxStake, Math.round(v)));
    this.stakePref = this.stake;
    this._save();
    return this.stake;
  }

  /* ================= the lobby clock's fallback bet ================= */

  /**
   * The marble carrying the least money right now.
   *
   * Ties go to the one with fewest backers, and then to the lowest index, so
   * this is a pure function of the board and never of call order.
   */
  leastBacked() {
    let best = 0;
    for (let i = 1; i < this.pools.length; i++) {
      if (this.pools[i] < this.pools[best] ||
         (this.pools[i] === this.pools[best] && this.backers[i] < this.backers[best])) best = i;
    }
    return best;
  }

  /**
   * The bet a backer gets when the lobby clock beats them to it.
   *
   * Minimum stake, on whatever is least backed. Both halves of that are
   * deliberate: the minimum is the least consequential bet that can be made on
   * someone's behalf, and the least-backed marble is the one whose odds are
   * longest, so an auto bet pushes the tote board towards even rather than
   * piling more money onto a favourite that is already short.
   *
   * Read it live rather than caching it: each auto bet changes the answer, so
   * a queue of them spreads across the board instead of landing in one heap.
   */
  autoStake() {
    return { marble: this.leastBacked(), amount: MIN_BET };
  }

  /** Auto-bet for the player. Returns the bet, or null if it could not stand. */
  autoBetPlayer() {
    if (this.placed || this.balance < MIN_BET) return null;
    const { marble, amount } = this.autoStake();
    this.selected = marble;
    this.stake = amount;
    return this.placeBet() ? { marble, amount, auto: true } : null;
  }

  /**
   * Auto-bet everyone still in the queue when the clock ran out.
   *
   * These are the backers who never got their money down, so they take the
   * fallback rather than the stake the seed drew for them. Nothing here
   * touches the race: it was decided from the seed when the round opened.
   */
  autoBetPending() {
    const out = [];
    while (this.pendingBots.length) {
      const queued = this.pendingBots.shift();
      const { marble, amount } = this.autoStake();
      const bot = { handle: queued.handle, marble, amount, whale: false, auto: true };
      this.bots.push(bot);
      this.pools[marble] += amount;
      this.backers[marble] += 1;
      out.push(bot);
    }
    return out;
  }

  placeBet() {
    if (this.placed) return false;
    if (this.selected < 0 || !this.canAfford(this.stake)) return false;

    this.balance -= this.stake;
    this.pools[this.selected] += this.stake;
    this.backers[this.selected] += 1;
    this.placed = true;

    this.stats.races += 1;
    this.stats.wagered += this.stake;
    this._save();
    return true;
  }

  /* ================= settlement ================= */

  /**
   * Settle the round against the finishing `order`.
   *
   * Accepts a bare index for the winner-takes-all case, so older callers keep
   * working, but the real form is the finishing order: the net pool is split
   * between positions by PLACE_SHARES, and each position's share is divided
   * among its backers in proportion to stake.
   *
   * Shares, not multiples. The pot is fixed at totalPool * (1 - rake), so a
   * position pays what its share divides into, it cannot pay a promised
   * figure the pot does not contain.
   */
  settle(order) {
    const finishing = Array.isArray(order) ? order : [order];
    const total = this.totalPool;
    const net = total * (1 - RAKE);
    const winnerIdx = finishing[0];

    const result = {
      winnerIdx,
      order: finishing.slice(),
      stake: this.stake,
      backed: this.selected,
      totalPool: total,
      rake: total * RAKE,
      netPool: net,
      onWinner: this.pools[winnerIdx] || 0,
      winners: 0,
      place: -1,           // where the backed marble finished, -1 if unplaced
      void: false,
      won: false,
      payout: 0,
      profit: 0,
      odds: 0,
      seed: this.seed,
      commitment: this.commitment,
      round: this.round,
    };

    const shares = this.payableShares(finishing);

    if (!shares) {
      // Nobody backed any paying position, so there is nothing to divide.
      result.void = true;
      result.payout = this.placed ? this.stake : 0;
      this.balance += result.payout;
    } else {
      result.winners = finishing.slice(0, PLACE_SHARES.length).reduce(
        (n, idx, i) => shares[i] > 0
          ? n + this.bots.filter(b => b.marble === idx).length +
            (this.selected === idx && this.placed ? 1 : 0)
          : n, 0);

      const at = finishing.indexOf(this.selected);
      const paying = at >= 0 && at < PLACE_SHARES.length && shares[at] > 0;

      if (this.placed && paying) {
        const on = this.pools[this.selected];
        result.place = at;
        result.won = at === 0;
        result.payout = (this.stake / on) * net * shares[at];
        result.profit = result.payout - this.stake;
        result.odds = result.payout / this.stake;
        this.balance += result.payout;

        this.stats.returned += result.payout;
        this.stats.best = Math.max(this.stats.best, result.profit);
        if (result.won) {
          this.stats.wins += 1;
          this.stats.streak = Math.max(0, this.stats.streak) + 1;
          this.stats.bestStreak = Math.max(this.stats.bestStreak, this.stats.streak);
        }
      } else if (this.placed) {
        result.profit = -this.stake;
        this.stats.streak = 0;
      }
    }

    this.form[winnerIdx] = (this.form[winnerIdx] || 0) + 1;

    this.history.unshift({
      round: this.round,
      winner: winnerIdx,
      backed: this.selected,
      stake: this.placed ? this.stake : 0,
      payout: result.payout,
      won: result.won,
      place: result.place,
      void: result.void,
      seed: this.seed,
    });
    if (this.history.length > 24) this.history.length = 24;

    this.round += 1;
    this._save();
    return result;
  }

  get netProfit() {
    return this.stats.returned - this.stats.wagered;
  }

  get winRate() {
    return this.stats.races ? this.stats.wins / this.stats.races : 0;
  }

  /** Demo faucet, keeps the prototype playable. */
  topUp(amount = STARTING_BALANCE) {
    this.balance += amount;
    this._save();
    return this.balance;
  }

  resetAll() {
    this.balance = STARTING_BALANCE;
    this.round = 1;
    this.history = [];
    this.stats = { races: 0, wins: 0, wagered: 0, returned: 0, best: 0, streak: 0, bestStreak: 0 };
    this.form = MARBLE_DATA.map(() => 0);
    this._save();
  }

  /* ================= persistence ================= */

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        balance: this.balance,
        round: this.round,
        history: this.history,
        stats: this.stats,
        form: this.form,
        stakePref: this.stakePref,
      }));
    } catch { /* private mode, run in memory */ }
  }
}

/* ================= formatting helpers ================= */

export function fmtAmount(v, dp = 2) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: Math.abs(n) >= 1000 ? 0 : dp,
    maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : dp,
  });
}

export function fmtOdds(o) {
  if (o === null || !isFinite(o)) return '-';
  return o.toFixed(2) + '×';
}
