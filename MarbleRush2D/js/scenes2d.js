// scenes2d.js: The set dressing behind each crypto section.
//
// Sanjay: the crypto machines "look like another normal section... make them
// feel crypto themed like how the chart section is". The chart works because
// the whole band BECOMES the thing (a trading screen with candles, a price
// tag and a news crawl), not because it has a label. So every crypto section
// here gets a scene: a backdrop that says what the machine is, a live
// read-out, and a pop-up when the machine does its thing to a marble.
//
// Rules, the same as the rest of the renderer:
//   - Drawn BEHIND the course and faint enough never to hide a wall or a peg.
//   - Reads the engine, never writes to it. Nothing here can change a race.
//   - Every name is invented: no real coin, chain, exchange or collection.
//   - Math.random is fine for sparkle; anything a viewer might compare
//     between two screens (a counter, a rarity) comes from a hash instead.

// The design's data face for everything drawn on the course (css/tokens.css --font-data).
const MONO = '"Barlow Condensed", "Arial Narrow", sans-serif';
const SANS = '"Barlow Condensed", "Arial Narrow", sans-serif';
const L = 40, R = 760;                        // the walls

const hash = (x) => { const v = Math.sin(x * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };

/** Where the scene being painted is: set by paintScenes for plate(). */
let CUR = null;
const SPOTS = new WeakMap();                  // per track: plate key -> chosen top-left

/** Is this world rectangle clear of everything a marble can touch? */
function rectClear(t, x0, y0, x1, y1) {
  const pad = 10;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const nearR = (x, y, r) => {
    const cx = x < x0 ? x0 : x > x1 ? x1 : x, cy = y < y0 ? y0 : y > y1 ? y1 : y;
    return (x - cx) ** 2 + (y - cy) ** 2 < r * r;
  };
  const segHits = (ax, ay, bx, by, r = 6) => {
    if (Math.max(ay, by) < y0 - r || Math.min(ay, by) > y1 + r) return false;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 6));
    for (let k = 0; k <= n; k++) if (nearR(ax + (bx - ax) * k / n, ay + (by - ay) * k / n, r)) return true;
    return false;
  };
  for (const g of t.segments) {
    if (g.ax === g.bx && (g.ax <= L || g.ax >= R)) continue;          // the side walls
    if (segHits(g.ax, g.ay, g.bx, g.by)) return false;
    // A tray's timer and label are drawn above it: keep off those too.
    if (g.tray && !g.quiet && segHits(g.ax, g.ay - 60, g.bx, g.by - 60, 44)) return false;
    // A quiet tray (Cascade tiers) has one shared tag centred 34 over it.
    if (g.tray && g.quiet && segHits(g.ax, g.ay - 38, g.bx, g.by - 38, 26)) return false;
  }
  for (const b of t.bumpers) if (nearR(b.x, b.y, b.r + 4)) return false;
  for (const o of t.rotors || []) if (nearR(o.cx, o.cy, o.len + o.fr)) return false;
  for (const o of t.movers || []) if (segHits(o.ax, o.ay, o.bx, o.by, o.r + 4)) return false;
  for (const c of t.cannons || []) if (nearR(c.x, c.y, c.catch + 20) || nearR(c.mx, c.my, 40)) return false;
  for (const f of t.flippers || []) if (nearR(f.px, f.py, f.len)) return false;
  for (const h of t.holes || []) if (nearR(h.x0 ?? h.x, h.y, (h.core ?? 30) + (h.sway || 0) + 20)) return false;
  for (const z of t.zones || []) {
    if (z.kind === 'fan' || z.kind === 'well') continue;
    if (z.x1 > x0 && z.x0 < x1 && z.y1 > y0 - 50 && z.y0 < y1) return false;   // claws hang 50 above
  }
  for (const p of t.springs || []) if (segHits(p.ax, p.ay, p.bx, p.by)) return false;
  return true;
}

/**
 * The nearest top-left to (px, py), section-local, where a w x h box is clear
 * of everything in the section; found once per course and kept.
 */
function spot(key, w, h, px, py) {
  if (!CUR) return [px, py];
  const { t, b } = CUR;
  let spots = SPOTS.get(t);
  if (!spots) SPOTS.set(t, spots = {});
  key = b.y0 + ':' + key;
  if (!spots[key]) {
    const H = b.y1 - b.y0;
    let best = null, bd = Infinity;
    for (let cy = 16; cy + h < H - 8; cy += 12) {
      for (let cx = L + 8; cx + w < R - 8; cx += 12) {
        if (cy < 70 && cx + w > 230 && cx < 570) continue;     // the section's name
        const d = (cx - px) ** 2 + (cy - py) ** 2;
        if (d >= bd) continue;
        if (rectClear(t, cx, b.y0 + cy, cx + w, b.y0 + cy + h)) { bd = d; best = [cx, cy]; }
      }
    }
    spots[key] = best || [px, py];
  }
  return spots[key];
}

/**
 * A glass read-out plate, the chart's price-tag style. (x, y, align) is only
 * where it would LIKE to be: it goes to the nearest spot in its section clear
 * of every wall, peg and machine (Sanjay: pegs were sitting on the cards),
 * worked out once per course and kept, so it never jumps about.
 */
function plate(g, x, y, lines, accent = '#a5b4fc', align = 'left') {
  g.font = `700 12px ${MONO}`;
  const w = Math.max(...lines.map(l => g.measureText(l).width)) + 22;
  const h = 10 + lines.length * 17;
  const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  // Room for the live numbers to grow: a right-aligned card keeps its right
  // edge and grows left into it, any other keeps its left edge.
  const room = 60;
  const [sx, y0] = spot(lines[0], w + room, h, align === 'right' ? px - room : px, y);
  const key = CUR ? CUR.b.y0 + ':' + lines[0] + ':w' : null;
  const spots = CUR && SPOTS.get(CUR.t);
  if (spots && spots[key] === undefined) spots[key] = w + room;
  const W = spots ? spots[key] : w + room;
  const x0 = align === 'right' ? sx + W - w : sx;
  g.fillStyle = 'rgba(14,12,10,0.72)';
  g.beginPath(); g.roundRect(x0, y0, w, h, 7); g.fill();
  g.fillStyle = accent;
  g.fillRect(x0, y0 + 6, 3, h - 12);
  g.textAlign = 'left';
  lines.forEach((l, i) => {
    g.fillStyle = i === 0 ? accent : 'rgba(235,233,230,0.85)';
    g.font = `${i === 0 ? 700 : 600} ${i === 0 ? 11 : 12}px ${MONO}`;
    g.fillText(l, x0 + 12, y0 + 19 + i * 17);
  });
}

/** A faint scrolling list of fake transactions: the mempool's texture. */
function txWall(g, clock, y0, y1, seed, alpha = 0.1, mark = -1) {
  g.save();
  g.beginPath(); g.rect(L, y0, R - L, y1 - y0); g.clip();
  g.font = `600 12px ${MONO}`;
  g.textAlign = 'left';
  const rowH = 22, scroll = (clock * 26) % rowH;
  for (let y = y0 - rowH + scroll, k = Math.floor(clock * 26 / rowH); y < y1; y += rowH, k--) {
    const h = hash(seed + k * 7.1);
    const addr = '0x' + Math.floor(h * 0xffffff).toString(16).padStart(6, '0') + '…' + Math.floor(hash(k + seed) * 0xfff).toString(16).padStart(3, '0');
    const kinds = ['swap', 'transfer', 'mint', 'approve', 'stake', 'bridge'];
    const txt = `${addr}  ${kinds[Math.floor(h * 6)].padEnd(8)} ${(h * 9000).toFixed(0).padStart(5)} MRBL   gas ${Math.floor(12 + h * 60)}`;
    const hot = mark >= 0 && ((k % 9) + 9) % 9 === mark;
    g.fillStyle = hot ? 'rgba(224,71,59,0.22)' : `rgba(211,202,193,${alpha})`;
    g.fillText(txt, L + 14, y);
    g.fillText(txt, L + 404, y);
  }
  g.restore();
}

/** A tiled hexagon lattice, for anything that is a network. */
function hexes(g, x0, y0, x1, y1, col, alpha) {
  g.save();
  g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
  g.strokeStyle = `rgba(${col},${alpha})`;
  g.lineWidth = 1.2;
  const s = 26, w = s * Math.sqrt(3);
  for (let row = 0, y = y0; y < y1 + s; row++, y += s * 1.5) {
    for (let x = x0 + (row % 2 ? w / 2 : 0); x < x1 + w; x += w) {
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + k * Math.PI / 3;
        k ? g.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s) : g.moveTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
      }
      g.closePath(); g.stroke();
    }
  }
  g.restore();
}

/** A generated 8x8 pixel creature, mirrored: an invented NFT, never a real one. */
function pixelArt(g, x, y, size, seed) {
  const hue = Math.floor(hash(seed) * 360);
  g.fillStyle = `hsl(${hue},60%,78%)`;
  g.fillRect(x, y, size, size);
  const px = size / 8;
  for (let j = 1; j < 7; j++) for (let i = 0; i < 4; i++) {
    if (hash(seed * 3.1 + j * 8 + i) < 0.5 - Math.abs(j - 3.5) * 0.04) continue;
    g.fillStyle = `hsl(${(hue + 180) % 360},55%,${30 + hash(seed + j) * 25}%)`;
    g.fillRect(x + (i + 0) * px, y + j * px, px, px);
    g.fillRect(x + (7 - i) * px, y + j * px, px, px);
  }
  g.fillStyle = '#fff';                     // eyes
  g.fillRect(x + 2 * px, y + 3 * px, px, px); g.fillRect(x + 5 * px, y + 3 * px, px, px);
  g.fillStyle = '#111';
  g.fillRect(x + 2 * px + px / 3, y + 3 * px + px / 3, px / 2, px / 2);
  g.fillRect(x + 5 * px + px / 3, y + 3 * px + px / 3, px / 2, px / 2);
}

const RARITY = [[0.55, 'COMMON', '#aba59f'], [0.85, 'RARE', '#3B87E6'], [0.97, 'EPIC', '#9161E3'], [1, 'LEGENDARY', '#fbbf24']];
const rarity = (h) => RARITY.find(r => h < r[0]);

/* ------------------------------ the scenes ------------------------------ */

const SCENES = {
  nftmint(g, b, S) {
    // A mint: holographic machine, a gallery of what it has minted, and a
    // numbered, graded NFT for every marble through the hatch.
    const holo = g.createLinearGradient(200, 200, 600, 520);
    const t = S.clock * 0.25;
    holo.addColorStop(0, `hsla(${(t * 360) % 360},80%,60%,0.12)`);
    holo.addColorStop(0.5, `hsla(${(t * 360 + 120) % 360},80%,60%,0.10)`);
    holo.addColorStop(1, `hsla(${(t * 360 + 240) % 360},80%,60%,0.12)`);
    g.fillStyle = holo; g.fillRect(200, 200, 400, 320);
    g.font = `700 64px ${SANS}`; g.textAlign = 'center';
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillText('MINT', 400, 470);
    // The gallery down both sides.
    const minted = S.count('mint');
    for (let k = 0; k < 4; k++) {
      const x = k < 2 ? 58 : 618, y = 215 + (k % 2) * 170, id = 4200 + Math.floor(hash(b.y0 + k) * 5000);
      const [, name, col] = rarity(hash(b.y0 * 1.3 + k));
      g.fillStyle = 'rgba(14,12,10,0.7)';
      g.beginPath(); g.roundRect(x - 6, y - 6, 136, 150, 8); g.fill();
      g.strokeStyle = col; g.lineWidth = 2; g.stroke();
      pixelArt(g, x, y, 124, b.y0 + k * 17);
      g.font = `700 11px ${MONO}`; g.textAlign = 'left'; g.fillStyle = '#ebe9e6';
      g.fillText(`#${id}`, x, y + 138);
      g.textAlign = 'right'; g.fillStyle = col;
      g.fillText(name, x + 124, y + 138);
    }
    plate(g, 400, 600, ['MINT LIVE', `minted ${minted} / 5 · 0.05 MRBL`], '#9161E3', 'center');
    // One NFT per marble out of the hatch.
    S.watch('mint', (m) => m.y > b.y0 + 590 && m.y < b.y0 + 700, (m) => {
      const h = hash(b.y0 + m.index * 31), [, name, col] = rarity(h);
      S.pop(m.x, m.y - 30, `#${4200 + Math.floor(h * 5000)} ${name}`, col);
    });
  },

  bridge(g, b, S) {
    // Two chains, each its own network, and the bridge between them.
    hexes(g, L, 150, 400, 560, '96,165,250', 0.08);
    hexes(g, 400, 150, R, 560, '192,132,252', 0.08);
    g.font = `700 22px ${SANS}`; g.textAlign = 'center';
    g.fillStyle = 'rgba(59,135,230,0.35)'; g.fillText('CHAIN A', 150, 430);
    g.fillStyle = 'rgba(145,97,227,0.35)'; g.fillText('CHAIN B', 650, 430);
    // Suspension cables over the gap.
    g.strokeStyle = 'rgba(165,180,252,0.12)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(140, 330); g.quadraticCurveTo(400, 120, 660, 330); g.stroke();
    for (let x = 180; x < 640; x += 40) {
      const u = (x - 140) / 520, y = (1 - u) * (1 - u) * 330 + 2 * (1 - u) * u * 120 + u * u * 330;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, 330); g.stroke();
    }
    const inTransit = S.E.marbles.filter(m => m.held && m.held.teleport).length;
    plate(g, R - 12, 470, ['CROSS-CHAIN', `in transit ${inTransit} · fee 0.3%`, `confirmations 12/12`], '#a5b4fc', 'right');
  },

  reorg(g, b, S) {
    // The chain itself, across the top: blocks tick on with the race clock,
    // and while any reorg is lit the tip forks and the old tip goes red.
    const lit = S.E.track.zones.some(z => z.kind === 'reorg' && z.y0 >= b.y0 && z.y1 <= b.y1 && S.E.zoneOn(z));
    const height = 812400 + Math.floor(S.E.time * 2);
    for (let k = 0; k < 7; k++) {
      const x = 130 + k * 80, y = 150, orphan = lit && k >= 5;
      g.fillStyle = orphan ? 'rgba(224,71,59,0.25)' : 'rgba(145,97,227,0.16)';
      g.strokeStyle = orphan ? 'rgba(224,71,59,0.7)' : 'rgba(145,97,227,0.45)';
      g.lineWidth = 2;
      g.beginPath(); g.roundRect(x, y - 18, 58, 36, 5); g.fill(); g.stroke();
      if (k) { g.beginPath(); g.moveTo(x - 22, y); g.lineTo(x, y); g.stroke(); }
      g.font = `700 10px ${MONO}`; g.textAlign = 'center';
      g.fillStyle = orphan ? '#fecdd3' : 'rgba(233,213,255,0.8)';
      g.fillText(`#${height - 6 + k}`, x + 29, y + 4);
    }
    if (lit) {
      g.strokeStyle = 'rgba(54,179,104,0.6)'; g.setLineDash([5, 4]);
      g.beginPath(); g.moveTo(468, 150); g.lineTo(508, 196); g.lineTo(660, 196); g.stroke(); g.setLineDash([]);
      g.font = `700 12px ${MONO}`; g.textAlign = 'right'; g.fillStyle = '#E0473B';
      g.fillText('REORG · 2 blocks orphaned', 700, 124);
    }
    // A marble jumping back up the band has just been reorged.
    S.watch('reorg', (m) => m.y > b.y0 && m.y < b.y1 && m.y < S.lastY(m) - 60, (m) => {
      S.pop(m.x, m.y - 30, 'ROLLED BACK', '#E0473B');
    }, true);
  },

  diamondhands(g, b, S) {
    // Faceted diamonds behind, a HODL meter in front.
    g.strokeStyle = 'rgba(126,232,255,0.11)'; g.lineWidth = 1.5;
    for (let k = 0; k < 9; k++) {
      const x = 110 + (k % 3) * 290 + (Math.floor(k / 3) % 2) * 140, y = 170 + Math.floor(k / 3) * 190, s = 46;
      g.beginPath();
      g.moveTo(x - s, y); g.lineTo(x - s * 0.55, y - s * 0.55); g.lineTo(x + s * 0.55, y - s * 0.55);
      g.lineTo(x + s, y); g.lineTo(x, y + s * 1.1); g.closePath();
      g.moveTo(x - s, y); g.lineTo(x + s, y);
      g.moveTo(x - s * 0.55, y - s * 0.55); g.lineTo(x, y + s * 1.1); g.lineTo(x + s * 0.55, y - s * 0.55);
      g.stroke();
    }
    const held = S.E.marbles.filter(m => m.frozen && m.frozenBy === 'grab' && m.y > b.y0 && m.y < b.y1).length;
    const meter = Math.min(1, held / 3);
    plate(g, L + 10, 580, ['HODL METER', `${held} holding · ${'█'.repeat(Math.round(meter * 8)).padEnd(8, '░')}`], '#7ee8ff');
    S.watch('grab', (m) => m.frozen && m.frozenBy === 'grab' && m.y > b.y0 && m.y < b.y1, (m) => {
      const z = S.E.track.zones.find(z => z.kind === 'grab' && Math.abs((z.x0 + z.x1) / 2 - m.x) < 2 && m.y > z.y0 - 30 && m.y < z.y1 + 30);
      S.pop(m.x, m.y - 64, z && z.diamond ? '💎 NEVER SELLING' : '🧻 PAPER HANDS', z && z.diamond ? '#7ee8ff' : '#e8d9b0');
    });
  },

  sandwich(g, b, S) {
    // The mempool the bots are reading, with the victim's trade highlighted
    // between the two that front-run and back-run it.
    txWall(g, S.clock, 120, 660, b.y0, 0.08, 4);
    plate(g, L + 10, 700, ['MEV WATCH', 'bots 7 · front-run ✓ · back-run ✓'], '#E0473B');
  },

  staking(g, b, S) {
    // Vault doors behind the two vaults, an APY board, a yield on payout.
    for (const x of [150, 650]) {
      g.strokeStyle = 'rgba(247,183,51,0.18)'; g.lineWidth = 6;
      g.beginPath(); g.arc(x, 372, 78, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 3;
      for (let k = 0; k < 6; k++) {
        const a = S.clock * 0.3 + k * Math.PI / 3;
        g.beginPath(); g.moveTo(x + Math.cos(a) * 20, 372 + Math.sin(a) * 20); g.lineTo(x + Math.cos(a) * 66, 372 + Math.sin(a) * 66); g.stroke();
      }
    }
    const apy = (7 + 3 * Math.sin(S.clock * 0.4)).toFixed(1);
    plate(g, R - 12, 560, ['STAKING POOL', `APY ${apy}% · lock 1.0s`, `TVL ${(1.2 + hash(b.y0) * 3).toFixed(2)}M MRBL`], '#f7b733', 'right');
    S.watch('vault', (m) => m.held && S.E.track.cannons[m.held.cannon]?.kind === 'vault', null, false, (m) => {
      S.pop(m.x, m.y - 30, `+${(2 + hash(b.y0 + m.index) * 9).toFixed(1)}% YIELD`, '#f7b733');
    });
  },

  consensus(g, b, S) {
    // The validator network: three nodes wired together, packets running
    // between them, and a finality read-out.
    const nodes = [[260, 170], [400, 170], [540, 170]];
    g.strokeStyle = 'rgba(54,179,104,0.15)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(260, 120); g.lineTo(400, 90); g.lineTo(540, 120); g.lineTo(260, 120); g.stroke();
    for (let k = 0; k < 3; k++) {
      const [a, c] = [[260, 120], [400, 90], [540, 120]][k], [d, e] = [[400, 90], [540, 120], [260, 120]][k];
      const f = (S.clock * 0.8 + k / 3) % 1;
      g.fillStyle = 'rgba(54,179,104,0.7)';
      g.beginPath(); g.arc(a + (d - a) * f, c + (e - c) * f, 3, 0, Math.PI * 2); g.fill();
    }
    for (const [x] of nodes) {
      g.fillStyle = 'rgba(14,12,10,0.8)'; g.strokeStyle = 'rgba(54,179,104,0.5)';
      g.beginPath(); g.roundRect(x - 26, 108 - (x === 400 ? 30 : 0), 52, 22, 5); g.fill(); g.stroke();
      g.font = `700 10px ${MONO}`; g.textAlign = 'center'; g.fillStyle = '#bbf7d0';
      g.fillText(`VAL-${(x - 120) / 140}`, x, 123 - (x === 400 ? 30 : 0));
    }
    plate(g, L + 10, 700, ['BFT', 'finality at 2 of 3 validators'], '#36B368');
  },

  moonshot(g, b, S) {
    // Night sky over the whole band, a big moon the rocket flies at, and a
    // leverage altimeter up the launch wall.
    const H = b.y1 - b.y0;
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, 'rgba(41,29,61,0.75)'); sky.addColorStop(0.6, 'rgba(24,18,34,0.55)'); sky.addColorStop(1, 'rgba(14,12,10,0.1)');
    g.fillStyle = sky; g.fillRect(L, 0, R - L, H);
    for (let k = 0; k < 90; k++) {
      const x = L + hash(b.y0 + k) * (R - L), y = hash(k * 3.7 + b.y0) * H * 0.9, tw = 0.35 + 0.65 * Math.abs(Math.sin(S.clock * 1.7 + k));
      g.fillStyle = `rgba(255,255,255,${0.75 * tw})`;
      const r = k % 7 === 0 ? 2.2 : 1.2;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // The moon, with a glow and craters.
    const mx = 210, my = 150;
    const glow = g.createRadialGradient(mx, my, 40, mx, my, 130);
    glow.addColorStop(0, 'rgba(254,243,199,0.35)'); glow.addColorStop(1, 'rgba(254,243,199,0)');
    g.fillStyle = glow; g.beginPath(); g.arc(mx, my, 130, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(254,240,190,0.9)';
    g.beginPath(); g.arc(mx, my, 56, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(214,196,140,0.7)';
    for (const [dx, dy, r] of [[-18, -12, 11], [16, 10, 8], [-6, 22, 6], [22, -20, 5]]) { g.beginPath(); g.arc(mx + dx, my + dy, r, 0, Math.PI * 2); g.fill(); }
    // The altimeter.
    g.font = `700 13px ${MONO}`; g.textAlign = 'left';
    g.strokeStyle = 'rgba(255,209,102,0.35)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(L + 10, 780); g.lineTo(L + 10, 260); g.stroke();
    for (const [y, t] of [[780, '1x'], [610, '10x'], [440, '100x'], [270, '1000x']]) {
      g.fillStyle = '#ffd166';
      g.fillRect(L + 4, y - 1, 16, 3);
      g.fillText(t, L + 24, y + 5);
    }
    S.watch('rocket', (m) => m.held && S.E.track.cannons[m.held.cannon]?.kind === 'rocket', null, false, (m) => {
      S.pop(m.x + 40, m.y - 40, 'TO THE MOON 🚀', '#ffd166');
    });
  },

  words(g, b, S) {
    // The peg words are neon on a dark sign board, with the post's numbers.
    for (const p of S.E.track.bumpers) {
      if (!p.word || p.y < b.y0 || p.y > b.y1) continue;
      const pulse = 0.18 + 0.08 * Math.sin(S.clock * 3 + p.x * 0.02);
      const gr = g.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.r + 18);
      gr.addColorStop(0, `rgba(255,209,102,${pulse})`); gr.addColorStop(1, 'rgba(255,209,102,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(p.x, p.y, p.r + 18, 0, Math.PI * 2); g.fill();
    }
    const likes = (1 + hash(b.y0) * 9).toFixed(1), rts = (0.3 + hash(b.y0 + 1) * 3).toFixed(1);
    plate(g, R - 12, b.y1 - b.y0 - 200, ['@marble · just now', `♥ ${likes}k   ↻ ${rts}k   💬 69`], '#ffd166', 'right');
  },

  mempool(g, b, S) {
    txWall(g, S.clock, 90, b.y1 - b.y0 - 60, b.y0, 0.06);
    plate(g, R - 12, 110, ['BLOCK BUILDER', `#${812400 + Math.floor(S.E.time * 2)} · filling`], '#fbbf24', 'right');
  },

  /* ---- lighter touches for the crypto-named sections ---- */

  gas(g, b, S) {
    const gwei = Math.round(30 + 25 * Math.sin(S.clock * 0.7) + 10 * Math.sin(S.clock * 2.3));
    // A gauge, in clear space near the top right.
    const [gx, gy] = spot('gauge', 110, 76, R - 125, 150);
    const cx = gx + 55, cy = gy + 50;
    g.strokeStyle = 'rgba(171,165,159,0.25)'; g.lineWidth = 8;
    g.beginPath(); g.arc(cx, cy, 40, Math.PI, 0); g.stroke();
    g.strokeStyle = gwei > 50 ? '#E0473B' : '#36B368'; g.lineWidth = 8;
    g.beginPath(); g.arc(cx, cy, 40, Math.PI, Math.PI + Math.PI * Math.min(1, gwei / 80)); g.stroke();
    g.font = `700 13px ${MONO}`; g.textAlign = 'center'; g.fillStyle = '#ebe9e6';
    g.fillText(`${gwei} gwei`, cx, cy + 18);
  },
  cold(g, b, S) {
    for (const x of [L, R]) {
      const gr = g.createLinearGradient(x, 0, x === L ? x + 120 : x - 120, 0);
      gr.addColorStop(0, 'rgba(160,230,255,0.14)'); gr.addColorStop(1, 'rgba(160,230,255,0)');
      g.fillStyle = gr; g.fillRect(x === L ? L : R - 120, 0, 120, b.y1 - b.y0);
    }
    plate(g, R - 12, 120, ['COLD WALLET', 'offline · air-gapped'], '#bdf0ff', 'right');
  },
  whale(g, b, S) {
    g.strokeStyle = 'rgba(59,135,230,0.12)'; g.lineWidth = 3;
    for (let k = 0; k < 4; k++) {
      g.beginPath();
      for (let x = L; x <= R; x += 10) {
        const y = b.y1 - b.y0 - 190 + k * 16 + Math.sin(x * 0.03 + S.clock * 1.5 + k) * 6;
        x === L ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
    plate(g, R - 12, 120, ['🐋 WHALE ALERT', `${(5 + hash(b.y0) * 40).toFixed(0)},000 MRBL moved`], '#3B87E6', 'right');
  },
  book(g, b, S) {
    // A bid/ask ladder: bids green on the left, asks red on the right.
    g.font = `600 11px ${MONO}`;
    for (let k = 0; k < 16; k++) {
      const y = 140 + k * 34, w1 = 40 + 120 * Math.abs(Math.sin(k * 1.7 + S.clock * 0.9)), w2 = 40 + 120 * Math.abs(Math.sin(k * 2.3 + S.clock * 0.7));
      g.fillStyle = 'rgba(54,179,104,0.08)'; g.fillRect(L, y, w1, 24);
      g.fillStyle = 'rgba(224,71,59,0.08)'; g.fillRect(R - w2, y, w2, 24);
      g.textAlign = 'left'; g.fillStyle = 'rgba(134,239,172,0.3)'; g.fillText((1 - k * 0.001).toFixed(4), L + 6, y + 16);
      g.textAlign = 'right'; g.fillStyle = 'rgba(252,165,165,0.3)'; g.fillText((1 + k * 0.001).toFixed(4), R - 6, y + 16);
    }
  },
  hash(g, b, S) {
    g.save(); g.beginPath(); g.rect(L, 0, R - L, b.y1 - b.y0); g.clip();
    g.font = `600 12px ${MONO}`; g.textAlign = 'left';
    for (let k = 0; k < 30; k++) {
      const y = ((k * 34 + S.clock * 40) % (b.y1 - b.y0));
      let s = '0000';
      for (let i = 0; i < 12; i++) s += Math.floor(hash(k * 13 + i + Math.floor(S.clock * 4)) * 16).toString(16);
      g.fillStyle = 'rgba(247,183,51,0.07)';
      g.fillText(s, L + 10 + (k % 2) * 360, y);
    }
    g.restore();
    plate(g, R - 12, 110, ['MINING', `hashrate ${(380 + hash(Math.floor(S.clock)) * 80).toFixed(0)} EH/s`, `nonce ${Math.floor(S.clock * 9999) % 99999}`], '#f7b733', 'right');
  },
  drop(g, b, S) {
    for (let k = 0; k < 6; k++) {
      const x = L + 60 + k * 120, y = 60 + ((S.clock * 30 + k * 70) % 240);
      g.strokeStyle = 'rgba(165,180,252,0.18)'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 18, Math.PI, 0); g.stroke();
      g.beginPath(); g.moveTo(x - 18, y); g.lineTo(x, y + 26); g.lineTo(x + 18, y); g.stroke();
      g.fillStyle = 'rgba(165,180,252,0.18)'; g.fillRect(x - 6, y + 26, 12, 10);
    }
    plate(g, R - 12, 120, ['AIRDROP', 'eligible ✓ · claim open'], '#a5b4fc', 'right');
  },
  firewall(g, b, S) {
    txWall(g, S.clock * 2, 110, b.y1 - b.y0 - 80, b.y0 + 5, 0.05);
    plate(g, R - 12, 120, ['FIREWALL', `blocked ${(1000 + Math.floor(S.clock * 37) % 900)} req/s`], '#E0473B', 'right');
  },
  halving(g, b, S) {
    plate(g, R - 12, 120, ['HALVING', 'block reward 6.25 → 3.125'], '#fbbf24', 'right');
  },
  rug(g, b, S) {
    plate(g, R - 12, 120, ['LIQUIDITY', 'locked ✓ (trust me)'], '#E0473B', 'right');
  },
  pool(g, b, S) {
    plate(g, R - 12, 110, ['LP POOL', `APR ${(20 + hash(b.y0) * 40).toFixed(0)}% · IL risk`], '#3B87E6', 'right');
  },
};

/** Which scene a section wears. */
const WEARS = {
  nftmint: 'nftmint', bridge: 'bridge', reorg: 'reorg', diamondhands: 'diamondhands',
  sandwich: 'sandwich', staking: 'staking', consensus: 'consensus', moonshot: 'moonshot',
  hodl: 'words', gm: 'words', wagmi: 'words', mempool: 'mempool',
  gaslimit: 'gas', coldstorage: 'cold', deepfreeze: 'cold', frostbite: 'cold',
  whale: 'whale', whales: 'whale', gravity: 'whale', orderbook: 'book', marketmakers: 'book', hft: 'book', liquidity: 'book',
  hashmill: 'hash', grinder: 'hash', miningwheel: 'hash', twinwheels: 'hash',
  airdrop: 'drop', presale: 'drop', faucet: 'drop', firewall: 'firewall', ddos: 'firewall',
  halving: 'halving', rugpull: 'rug', bulltrap: 'rug', cascade: 'pool', liquiditypool: 'pool', waterfall: 'pool',
};

export function hasScene(id) { return !!WEARS[id]; }

/**
 * Paint every visible section's scene, and the pop-ups the machines raise.
 */
const STATE = new WeakMap();                  // per engine: a replay never disturbs the live race

export function paintScenes(g, E, top, bot, clock) {
  let st = STATE.get(E);
  // A new race on the same engine (reset) starts the scenes clean too.
  if (!st || st.t0 > E.time + 0.5) { st = { seen: {}, pops: [], counts: {}, prev: {}, lastY: [], clock }; STATE.set(E, st); }
  st.t0 = E.time;
  const dt = Math.min(0.1, Math.max(0, clock - st.clock));
  st.clock = clock;
  for (const b of E.track.sections) {
    const name = WEARS[b.id];
    if (!name || b.y1 < top - 100 || b.y0 > bot + 100) continue;
    const S = {
      E, clock,
      pop: (x, y, text, col) => st.pops.push({ x, y, text, col, t: 0 }),
      lastY: (m) => st.lastY[m.index] ?? m.y,
      count: (key) => st.counts[b.y0 + key] || 0,
      // Fire `fn` once per marble when `test` first holds in this band; with
      // `onEnd`, fire when it STOPS holding (a vault paying out).
      watch: (key, test, fn, every = false, onEnd) => {
        for (const m of E.marbles) {
          if (m.out) continue;
          const k = `${b.y0}:${key}:${m.index}`, now = !!test(m), was = st.prev[k];
          st.prev[k] = now;
          if (fn && now && !was && (every || !st.seen[k])) { st.seen[k] = true; st.counts[b.y0 + key] = (st.counts[b.y0 + key] || 0) + 1; fn(m); }
          if (onEnd && was && !now) onEnd(m);
        }
      },
    };
    // The scene draws in section space; marbles and pop-ups are in world
    // space, which is why watch() tests take world y.
    g.save();
    g.translate(0, b.y0);
    CUR = { t: E.track, b };
    SCENES[name](g, b, S);
    CUR = null;
    g.restore();
  }
  for (const m of E.marbles) st.lastY[m.index] = m.y;
  st.pops = st.pops.filter(p => (p.t += dt) < 1.6);
}

/** The pop-ups, drawn last so they sit over the marbles. Rise and fade over 1.6s. */
export function paintPops(g, E) {
  const st = STATE.get(E);
  if (!st) return;
  for (const p of st.pops) {
    const a = Math.min(1, (1.6 - p.t) * 2);
    g.globalAlpha = a;
    g.font = `700 14px ${SANS}`;
    const w = g.measureText(p.text).width + 18, y = p.y - p.t * 40;
    g.fillStyle = 'rgba(14,12,10,0.85)';
    g.beginPath(); g.roundRect(p.x - w / 2, y - 16, w, 24, 12); g.fill();
    g.strokeStyle = p.col; g.lineWidth = 1.5; g.stroke();
    g.fillStyle = p.col; g.textAlign = 'center';
    g.fillText(p.text, p.x, y + 1);
    g.globalAlpha = 1;
  }
}
