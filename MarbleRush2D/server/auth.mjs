// auth.mjs: sign in with a Solana wallet. No dependencies.
//
//   1. POST /api/auth/nonce   { address }              -> { nonce, message }
//   2. the wallet signs `message` (an off-chain signature: no transaction, no fee)
//   3. POST /api/auth/verify  { address, nonce, signature }
//                                                      -> Set-Cookie: mr_session
//
// A wallet address IS an ed25519 public key (base58), so the server can check
// the signature itself. It never sees a private key. The message is built by
// the server and remembered, so the client cannot talk the server into
// accepting a different one; each nonce works once and expires in five
// minutes. The session token is random, lives in an HttpOnly cookie, and only
// its SHA-256 is stored.

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}

export function b58decode(str) {
  if (typeof str !== 'string' || !str.length || str.length > 100) return null;
  let n = 0n;
  for (const c of str) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of str) { if (c === '1') out.unshift(0); else break; }
  return Uint8Array.from(out);
}

/** A Solana address is 32 bytes. Returns them, or null. */
export function addressBytes(address) {
  const b = b58decode(address);
  return b && b.length === 32 ? b : null;
}

// DER prefix that wraps a raw 32-byte ed25519 key as SubjectPublicKeyInfo.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
export function verifySignature(pub32, message, sig) {
  if (!sig || sig.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pub32)]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sig));
  } catch { return false; }
}

/** `7xKp…9Qa`: what other players see. The full address stays private to the wallet owner. */
export const shortAddress = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createAuth({ dir, nonceMs = 5 * 60_000, sessionMs = 14 * 86_400_000, clock = Date.now }) {
  const nonces = new Map();       // nonce -> { address, message, exp }
  const sessions = new Map();     // sha256(token) -> { pid, exp }
  const issued = new Map();       // ip -> [timestamps], for the rate limit
  let dirty = false;

  const file = path.join(dir, 'sessions.json');
  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const t = clock();
      for (const [k, v] of Object.entries(raw)) if (v.exp > t) sessions.set(k, v);
    } catch { /* first run */ }
  }
  async function save() {
    if (!dirty) return;
    dirty = false;
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
  }

  function prune() {
    const t = clock();
    for (const [k, v] of nonces) if (v.exp <= t) nonces.delete(k);
    for (const [k, v] of sessions) if (v.exp <= t) { sessions.delete(k); dirty = true; }
    for (const [ip, l] of issued) { const keep = l.filter(x => x > t - 60_000); if (keep.length) issued.set(ip, keep); else issued.delete(ip); }
  }

  /** Step 1. `host` goes into the message so a signature is tied to this site. */
  function issueNonce({ address, host, ip }) {
    if (!addressBytes(address)) return { error: 'not a Solana address' };
    prune();
    const t = clock();
    const recent = issued.get(ip) || [];
    if (recent.length >= 12 || nonces.size > 5000) return { error: 'slow down', status: 429 };
    recent.push(t); issued.set(ip, recent);
    const nonce = randomBytes(16).toString('hex');
    const message =
      `${host} wants you to sign in with your Solana account:\n${address}\n\n` +
      `Sign in to MarbleRush. This is a free signature: no transaction, no fee, no access to your funds.\n\n` +
      `Nonce: ${nonce}\nIssued At: ${new Date(t).toISOString()}\nExpiration Time: ${new Date(t + nonceMs).toISOString()}`;
    nonces.set(nonce, { address, message, exp: t + nonceMs });
    return { nonce, message };
  }

  /** Step 3. Returns { token, pid } or { error }. */
  function verifyLogin({ address, nonce, signature }) {
    const rec = nonces.get(nonce);
    nonces.delete(nonce);                                  // one try per nonce, pass or fail
    if (!rec || rec.address !== address || rec.exp <= clock()) return { error: 'sign-in expired, try again' };
    const pub = addressBytes(address);
    const sig = typeof signature === 'string' ? Buffer.from(signature, 'base64') : null;
    if (!pub || !verifySignature(pub, rec.message, sig)) return { error: 'signature did not match' };
    const token = randomBytes(32).toString('hex');
    sessions.set(sha256(token), { pid: address, exp: clock() + sessionMs });
    while (sessions.size > 20000) sessions.delete(sessions.keys().next().value);   // oldest first: a flood of throwaway keys cannot grow this without bound
    dirty = true;
    return { token, pid: address, maxAge: Math.floor(sessionMs / 1000) };
  }

  function sessionPid(token) {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const s = sessions.get(sha256(token));
    if (!s) return null;
    if (s.exp <= clock()) { sessions.delete(sha256(token)); dirty = true; return null; }
    return s.pid;
  }

  function logout(token) {
    if (token && sessions.delete(sha256(token))) dirty = true;
  }

  return { load, save, issueNonce, verifyLogin, sessionPid, logout };
}

export function parseCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
