// first-bet-e2e.mjs: a table that starts on the first bet stays quiet until someone bets (demo money, no chain).
//
//   node MarbleRush2D/tools/first-bet-e2e.mjs
//
// Two tables with house stakes. "practice" has startOn "bet" and "watch" has startOn "player" (below): its round opens when someone watches, but the lobby clock does not run
// and no house stake is placed until a player bets. Then the clock starts, the house stakes come in and the race runs.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'mr-firstbet-e2e-'));
writeFileSync(join(dir, 'tables.json'), JSON.stringify({ tables: [
  { id: 'practice', name: 'Practice', minPlayers: 0, maxPlayers: 20, bots: 'house', botBudget: 100, startOn: 'bet' },
  { id: 'closed', name: 'Closed', minPlayers: 3, maxPlayers: 20, bots: 'none', disabled: true },
  { id: 'watch', name: 'Watch', minPlayers: 0, maxPlayers: 20, bots: 'house', botBudget: 100, startOn: 'player', idleRounds: 1 },
] }));
process.env.MR_TABLES = join(dir, 'tables.json');
process.env.MR_DATA = join(dir, 'data');
process.env.MR_LOBBY = '4'; process.env.MR_BLOCKS = '6';

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };
const opens = () => logs.filter(l => /^\[round \d+\] open/.test(l)).length;
const { start } = await import('../server/server.mjs');
const { b58encode } = await import('../server/auth.mjs');
const PORT = 8197, base = `http://localhost:${PORT}`;
let failures = 0;
const check = (ok, what) => { realLog(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const server = await start(PORT);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const address = b58encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const post = async (p, body, cookie) => { const r = await fetch(`${base}/api/${p}`, { method: 'POST', body: JSON.stringify(body), headers: cookie ? { cookie } : {} }); return { code: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie') }; };
const events = [], waiters = [];
(async () => {
  const res = await fetch(`${base}/api/events?table=practice`);
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
      if (!ev || !data) continue;
      const e = { type: ev[1], data: JSON.parse(data[1]), at: Date.now() };
      events.push(e);
      for (const w of waiters.slice()) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.ok(e); }
    }
  }
})().catch(() => {});
const wait = (pred, ms = 60000) => { const hit = events.find(pred); return hit ? Promise.resolve(hit) : new Promise((ok, no) => { waiters.push({ pred, ok }); setTimeout(() => no(new Error('timeout')), ms); }); };

realLog('\n  a table that starts on the first bet\n');
const open = await wait(e => e.type === 'round');
check(open.data.id === 1 && open.data.phase === 'betting' && open.data.waiting === true && open.data.table.startOn === 'bet', 'a visitor wakes the table: round 1 is open and waiting for the first bet');

await sleep(7000);                      // longer than the 4 s lobby, with no bet
check(opens() === 1 && !events.some(e => e.type === 'round' && e.data.id === 1 && e.data.phase !== 'betting'), 'with nobody betting, nothing starts: no new round, no countdown');
check(open.data.bets.length === 0 && events.filter(e => e.type === 'pool').every(e => e.data.bets.length === 0), 'and the house stakes have not been placed');
const list = await (await fetch(`${base}/api/tables`)).json();
const row = (list.tables || list).find(t => t.id === 'practice');
check(row && row.waiting === true && row.closesAt === null && row.startOn === 'bet', 'the table list says it is waiting, with no closing time');

const n = await post('auth/nonce', { address });
const v = await post('auth/verify', { address, nonce: n.body.nonce, signature: sign(null, Buffer.from(n.body.message), privateKey).toString('base64') });
const cookie = v.cookie.split(';')[0];
const t0 = Date.now();
const bet = await post('bet', { table: 'practice', marble: 2, amount: 10 }, cookie);
check(bet.code === 200, 'a player bets');
const started = await wait(e => e.type === 'round' && e.data.id === 1 && e.data.waiting === false);
check(started.data.closesAt - started.data.opensAt === 4000 && started.data.closesAt - Date.now() > 2500, 'the lobby clock starts from that bet (4 s on the clock)');
// a page that reconnects (or reloads) mid-round is told it already has a bet, so nothing is lost or placed twice
const again = await fetch(`${base}/api/events?table=practice`, { headers: { cookie } });
const reader = again.body.getReader(); let text = '';
while (!/event: hello[\s\S]*\n\n/.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
reader.cancel().catch(() => {});
const hello = JSON.parse(/event: hello\ndata: (.*)/.exec(text)[1]);
check(hello.mine && hello.mine.round === 1 && hello.mine.marble === 2 && hello.mine.amount === 10, 'reconnecting: the server tells the page about its own bet in this round');
const cd = await wait(e => e.type === 'round' && e.data.id === 1 && e.data.phase === 'countdown', 20000);
check(cd.at - t0 >= 3500, `the race starts a lobby later, not before (${((cd.at - t0) / 1000).toFixed(1)} s after the bet)`);
const house = cd.data.bets.filter(b => !b.human);
check(cd.data.bets.some(b => b.human) && house.length >= 5, `the house stakes joined once there was a player (${house.length} of them)`);
const res = await wait(e => e.type === 'round' && e.data.id === 1 && e.data.phase === 'results', 120000);
check(res.data.result && res.data.result.finishOrder.length === 5, 'and the round raced to a result');

// --- startOn "player": a signed-in wallet watching the table starts it, even before it bets -------------------------------
realLog('\n  a table that starts when a wallet joins\n');
function watch(table, cookie) {
  const evs = [], ws = [], ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${base}/api/events?table=${table}`, { signal: ctrl.signal, headers: cookie ? { cookie } : {} });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
        if (!ev || !data) continue;
        const e = { type: ev[1], data: JSON.parse(data[1]), at: Date.now() };
        evs.push(e);
        for (const w of ws.slice()) if (w.pred(e)) { ws.splice(ws.indexOf(w), 1); w.ok(e); }
      }
    }
  })().catch(() => {});
  return { evs, close: () => ctrl.abort(), wait: (pred, ms = 30000) => { const hit = evs.find(pred); return hit ? Promise.resolve(hit) : new Promise((ok, no) => { ws.push({ pred, ok }); setTimeout(() => no(new Error('timeout')), ms); }); } };
}
const guest = watch('watch');
const g1 = await guest.wait(e => e.type === 'round');
check(g1.data.waiting === true && g1.data.table.startOn === 'player', 'a guest wakes the table: it waits');
await sleep(6000);
check(!guest.evs.some(e => e.type === 'round' && e.data.waiting === false) && g1.data.bets.length === 0, 'a spectator who has not connected a wallet does not start it (6 s, longer than the lobby)');
const signed = watch('watch', cookie);
const t1 = Date.now();
const go = await guest.wait(e => e.type === 'round' && e.data.waiting === false, 5000);
check(Date.now() - t1 < 3000 && go.data.closesAt - go.data.opensAt === 4000, 'a connected wallet joins the table: the lobby clock starts at once, with no bet placed');
const cd2 = await guest.wait(e => e.type === 'round' && e.data.phase === 'countdown', 20000);
check(cd2.data.bets.filter(b => !b.human).length >= 5 && !cd2.data.bets.some(b => b.human), 'it races with the house stakes, though the wallet never bet');
// ...but a wallet that just sits there is not enough for ever: after idleRounds rounds with no bet, the next one waits for a bet
const idle = await signed.wait(e => e.type === 'round' && e.data.id > cd2.data.id && e.data.phase === 'betting', 90000);
check(idle.data.waiting === true && idle.data.needBet === true, 'after a round nobody bet in, the next round waits for a bet even with a wallet connected');
await sleep(6000);
check(!signed.evs.some(e => e.type === 'round' && e.data.id === idle.data.id && e.data.waiting === false), 'and it stays waiting (6 s, longer than the lobby) until someone bets');
signed.close(); guest.close();

// --- a disabled table is listed, greyed out, and never opens --------------------------------------------------------------
realLog('\n  a table that is closed (coming soon)\n');
const opensBefore = opens();
const all = (await (await fetch(`${base}/api/tables`)).json()).tables;
const closed = all.find(t => t.id === 'closed');
check(closed && closed.disabled === true && closed.phase === 'asleep', 'it is in the table list, marked disabled');
const viaClosed = await fetch(`${base}/api/events?table=closed&pin=1`);
const rd = viaClosed.body.getReader(); let seen = '';
while (!/event: hello[\s\S]*\n\n/.test(seen)) { const { value, done } = await rd.read(); if (done) break; seen += new TextDecoder().decode(value); }
rd.cancel().catch(() => {});
check(JSON.parse(/event: hello\ndata: (.*)/.exec(seen)[1]).table !== 'closed', 'asking for it, even pinned, seats you at an open table instead');
check(!logs.some(l => /table closed|closed.*open/.test(l)) && (await (await fetch(`${base}/api/tables`)).json()).tables.find(t => t.id === 'closed').phase === 'asleep' && opens() >= opensBefore, 'no round was ever opened on it');
const noBet = await post('bet', { table: 'closed', marble: 1, amount: 10 }, cookie);
check(noBet.code >= 400, `and a bet on it is refused (${noBet.code})`);

realLog(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
server.close();
process.exit(failures ? 1 : 0);
