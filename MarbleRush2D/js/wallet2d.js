// wallet2d.js: connect a Solana wallet and sign in with it.
//
// Phantom, Solflare and Backpack all inject a provider into the page with the
// same two calls: connect() and signMessage(). Signing a message is free and
// off-chain: no transaction, no fee, nothing moves. The server checks the
// signature against the address (server/auth.mjs) and answers with a session
// cookie, so this module never holds anything secret.

export function walletProviders() {
  const w = window, found = [];
  const add = (id, name, p, url) => {
    if (p && typeof p.connect === 'function' && typeof p.signMessage === 'function') found.push({ id, name, p, url });
  };
  add('phantom', 'Phantom', w.phantom?.solana?.isPhantom ? w.phantom.solana : (w.solana?.isPhantom ? w.solana : null));
  add('solflare', 'Solflare', w.solflare?.isSolflare ? w.solflare : null);
  add('backpack', 'Backpack', w.backpack?.isBackpack ? w.backpack : null);
  return found;
}

export const WALLET_LINKS = [
  { name: 'Phantom', url: 'https://phantom.com/download' },
  { name: 'Solflare', url: 'https://solflare.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/download' },
];

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function post(path, body) {
  const r = await fetch(`/api/${path}`, { method: 'POST', body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'sign-in failed');
  return data;
}

const WALLET_KEY = 'marblerush.wallet';

/** The name of the wallet this browser signed in with ("Phantom"), or a plain fallback, for button copy. */
export function walletName() {
  let id = null;
  try { id = localStorage.getItem(WALLET_KEY); } catch { /* private mode */ }
  const names = { phantom: 'Phantom', solflare: 'Solflare', backpack: 'Backpack' };
  return names[id] || 'your wallet';
}

/** The wallet this browser signed in with, connected again (silently when it is already trusted). */
export async function activeProvider(address) {
  let id = null;
  try { id = localStorage.getItem(WALLET_KEY); } catch { /* private mode */ }
  const all = walletProviders();
  const prov = all.find(w => w.id === id) || all[0];
  if (!prov) throw new Error('Your wallet is not available in this browser');
  let res;
  try { res = await prov.p.connect({ onlyIfTrusted: true }); } catch { res = await prov.p.connect(); }
  const got = String((res && res.publicKey) || prov.p.publicKey || '');
  if (address && got && got !== address) throw new Error(`Switch your wallet to ${address.slice(0, 4)}…${address.slice(-4)}, the account you signed in with`);
  return prov;
}

/** Sign the bet transaction the server built (the server pays the fee; we only add the player's signature). */
export async function signBet(address, txBase64) {
  const prov = await activeProvider(address);
  const { Transaction } = await import('./vendor/solana-web3.js');
  const tx = Transaction.from(Uint8Array.from(atob(txBase64), c => c.charCodeAt(0)));
  let signed;
  try { signed = await prov.p.signTransaction(tx); }
  catch (e) { throw new Error(e && (e.code === 4001 || /reject|denied|cancel/i.test(e.message || '')) ? 'Bet cancelled in the wallet' : (e.message || 'The wallet could not sign')); }
  return toBase64(signed.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/** Connect `provider`, have it sign the server's message, trade that for a session. */
export async function signIn(provider) {
  const p = provider.p;
  let address;
  try {
    const res = await p.connect();
    address = String((res && res.publicKey) || p.publicKey || '');
    if (!address) throw new Error('the wallet gave no address');
    const { nonce, message } = await post('auth/nonce', { address });
    const signed = await p.signMessage(new TextEncoder().encode(message), 'utf8');
    const signature = toBase64(signed.signature || signed);
    const out = await post('auth/verify', { address, nonce, signature });
    try { localStorage.setItem(WALLET_KEY, provider.id); } catch { /* fine */ }
    return out;
  } catch (e) {
    // 4001 is the wallet's code for "the user closed the popup".
    if (e && (e.code === 4001 || /reject|denied|cancel/i.test(e.message || ''))) throw new Error('Sign-in cancelled in the wallet');
    throw e;
  }
}

export async function signOut(providers = walletProviders()) {
  await fetch('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  for (const { p } of providers) { try { await p.disconnect?.(); } catch { /* the wallet may already be disconnected */ } }
}
