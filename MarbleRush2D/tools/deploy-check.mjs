// deploy-check.mjs: start the server the way the cloud VM will, and see that it comes up right.
//
//   node MarbleRush2D/tools/deploy-check.mjs
//
// A real deploy has no key file: the house key and the RPC address arrive as environment variables, the data
// folder is empty apart from the public chain.json, the port is PORT, and a reverse proxy sits in front. This runs
// the server with exactly that, reading the secrets from the local data folder only to pass
// them as environment variables, and never printing them. It uses devnet RPC reads only: nothing is spent.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.MR_CHAIN_DIR || join(HERE, '..', 'server', 'data');
const SERVER = join(HERE, '..', 'server', 'server.mjs');
const PORT = 8087, base = `http://localhost:${PORT}`;
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

const authority = readFileSync(join(SRC, 'authority.json'), 'utf8').trim();
const rpc = existsSync(join(SRC, 'rpc-url.txt')) ? readFileSync(join(SRC, 'rpc-url.txt'), 'utf8').split('\n')[0].trim() : '';
const volume = mkdtempSync(join(tmpdir(), 'mr-deploy-'));
copyFileSync(join(SRC, 'chain.json'), join(volume, 'chain.json'));         // the one data file the server gets besides secrets

function run(env, { stopWhen, ms = 40000 }) {
  return new Promise((ok) => {
    const child = spawn('node', [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', done = false;
    const finish = (how) => { if (done) return; done = true; clearTimeout(t); ok({ child, log, how }); };
    const on = (d) => { log += d; if (stopWhen && stopWhen.test(log)) finish('ready'); };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (code) => finish(`exit ${code}`));
    const t = setTimeout(() => finish('timeout'), ms);
  });
}

console.log('\n  the server as a host starts it\n');
const common = { PORT: String(PORT), MR_DATA: volume, MR_CHAIN_DIR: volume, MR_TRUST_PROXY: '1', MR_HOST: '127.0.0.1', MR_SECURE: '1', MR_REQUIRE_CHAIN: '1', MR_AUTHORITY_KEY: authority, ...(rpc ? { MR_RPC: rpc } : {}) };

const up = await run(common, { stopWhen: /MarbleRush server on/ });
check(up.how === 'ready', 'it starts and listens on PORT');
if (up.how === 'ready') {
  const info = await (await fetch(`${base}/api/chain`)).json();
  check(info.cluster === 'devnet' && info.tokens.some(t => t.symbol === 'RUSH'), 'the chain is open from environment variables alone (devnet, RUSH)');
  check(!existsSync(join(volume, 'authority.json')), 'no key file was written to the data folder');
  const page = await fetch(`${base}/MarbleRush2D/index.html`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.5' } });
  check(page.headers.get('strict-transport-security') !== null && (await page.text()).includes(`content="http`), 'pages carry HSTS and the preview image is an absolute address');
  check((await fetch(`${base}/api/ping`)).status === 200, 'the health check answers');
  check(!up.log.includes(authority.slice(1, 40)) && (!rpc || !up.log.includes(rpc)), 'neither the key nor the RPC address appears in the log');
}
up.child.kill('SIGKILL');
await new Promise(r => setTimeout(r, 500));

const bare = await run({ ...common, MR_AUTHORITY_KEY: '' }, { stopWhen: /MarbleRush server on/, ms: 30000 });
check(/exit [1-9]/.test(bare.how) && /MR_REQUIRE_CHAIN/.test(bare.log), 'without the key it refuses to start, instead of quietly playing with demo money');
bare.child.kill('SIGKILL');

console.log(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
