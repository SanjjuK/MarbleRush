// stats.js: the public stats page. Reads /api/stats every few seconds and draws it. All text goes in
// through textContent (or an escaped helper): nothing from the network is ever parsed as HTML.
import { MARBLE_DATA } from '../../js/racers.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, max = 2) => Number(v).toLocaleString(undefined, { maximumFractionDigits: max });
const PHASE = { asleep: 'Quiet', betting: 'Betting', countdown: 'Starting', racing: 'Racing', results: 'Results' };

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}
const cell = (content, cls = '') => { const td = el('td', cls ? { class: cls } : {}); if (typeof content === 'string') td.textContent = content; else if (content) td.append(content); return td; };
function fill(tbody, rows, cols) {
  tbody.replaceChildren(...(rows.length ? rows : [el('tr', {}, Object.assign(el('td', { class: 'empty', colspan: String(cols) }), { textContent: 'Nothing yet' }))]));
}
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function explorer(cluster, sig) { return `https://explorer.solana.com/tx/${encodeURIComponent(sig)}${cluster && cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(cluster)}` : ''}`; }
function link(cluster, sig, label) { return el('a', { href: explorer(cluster, sig), target: '_blank', rel: 'noopener noreferrer', title: sig, text: label }); }

function draw(d) {
  $('tPlayers').textContent = fmt(d.totals.players, 0);
  $('tRounds').textContent = fmt(d.totals.rounds, 0);
  $('tRoundsNote').textContent = `since ${when(d.since)}`;
  $('tBets').textContent = fmt(d.totals.bets, 0);
  $('tCancel').textContent = fmt(d.totals.cancelled, 0);

  fill($('tokens').tBodies[0], Object.entries(d.tokens).map(([sym, t]) => el('tr', {},
    cell(sym === 'DEMO' ? 'Demo money' : sym), cell(fmt(t.staked), 'n'), cell(fmt(t.paid + t.voided), 'n'), cell(fmt(t.houseNet), 'n'), cell(fmt(t.cancelledRefunded), 'n'), cell(fmt(t.rounds, 0), 'n'))), 6);

  $('liveNote').textContent = `${d.live.connections} watching · ${d.live.bettors} betting`;
  fill($('tables').tBodies[0], d.live.tables.map((t) => el('tr', {},
    cell(t.name), cell(t.token || '-'), cell(PHASE[t.phase] || t.phase), cell(fmt(t.bettors, 0), 'n'), cell(fmt(t.seats, 0), 'n'), cell(fmt(t.viewers, 0), 'n'),
    cell(`${t.minPlayers ? `needs ${t.minPlayers} players` : t.startOn === 'player' ? 'starts when a wallet joins' : t.startOn === 'bet' ? 'starts on the first bet' : 'always races'}, ${t.bots === 'house' ? 'house stakes' : 'players only'}`))), 7);

  fill($('recent').tBodies[0], d.recent.map((r) => {
    const names = (r.order || []).slice(0, 2).map(i => (MARBLE_DATA[i] || {}).name || `#${i + 1}`);
    const result = r.cancelled ? el('span', { class: 'tag cancel', text: 'CANCELLED' }) : document.createTextNode(names.join(' › '));
    const sigs = el('div', { class: 'sigs' });
    if (r.commit) sigs.append(link(d.cluster, r.commit, 'sealed'));
    if (r.reveal) sigs.append(link(d.cluster, r.reveal, 'revealed'));
    if (r.payouts && r.payouts.length) sigs.append(link(d.cluster, r.payouts[0], `${r.payoutKind === 'refund' ? 'refunded' : 'paid'}${r.payouts.length > 1 ? ` (+${r.payouts.length - 1})` : ''}`));
    const resultTd = cell(result);
    if (r.cancelled) resultTd.append(el('small', { text: r.cancelled }));
    return el('tr', {}, cell(String(r.id), 'n'), cell(r.name || r.table, ''), cell(fmt(r.bettors, 0), 'n'), cell(r.cancelled ? '-' : `${fmt(r.pool)} ${r.token === 'DEMO' ? '' : r.token}`, 'n'), resultTd, cell(sigs.childNodes.length ? sigs : (r.token === 'DEMO' ? 'demo money' : 'pending')));
  }), 6);
  $('upd').textContent = `Updated ${new Date(d.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

async function tick() {
  try {
    const r = await fetch('/api/stats', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    draw(await r.json());
  } catch { $('upd').textContent = 'Reconnecting…'; }
}
tick();
setInterval(() => { if (!document.hidden) tick(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
