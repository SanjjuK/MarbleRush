// rng.js — Seeded deterministic pseudo-random number generator.
//
// Every race is driven by a seed so the same seed reproduces the same result.
// That is the groundwork for a provably-fair scheme later on: publish
// hash(serverSeed) before the race, reveal serverSeed after.

/** xmur3 string hash → 32-bit seed */
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 — small, fast, good enough distribution */
export function makeRng(seedStr) {
  let a = hashSeed(String(seedStr));
  const next = () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range  = (lo, hi) => lo + next() * (hi - lo);
  next.int    = (lo, hi) => Math.floor(next.range(lo, hi + 1));
  next.pick   = (arr)    => arr[Math.floor(next() * arr.length)];
  next.spread = (m)      => (next() - 0.5) * 2 * m;
  return next;
}

/** Random 12-char hex seed for a fresh round */
export function generateSeed() {
  const bytes = new Uint8Array(6);
  (globalThis.crypto || {}).getRandomValues
    ? crypto.getRandomValues(bytes)
    : bytes.forEach((_, i) => (bytes[i] = Math.floor(Math.random() * 256)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Short display hash of a seed — stands in for a commitment hash */
export function seedCommitment(seed) {
  const h = hashSeed('commit:' + seed).toString(16).padStart(8, '0');
  const g = hashSeed(h + seed).toString(16).padStart(8, '0');
  return (h + g).slice(0, 16);
}
