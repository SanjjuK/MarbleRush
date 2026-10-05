// codeversion.mjs: which version of the race code is this?
//
// The determinism print (js/detcheck.js) races one fixed course, so it only notices a change in the
// rules that course happens to use. A change to any OTHER section changes races without changing
// the print. This hashes the SOURCE of every file that can change a race, so any edit shows up.
//
// The browser hashes the same files as the server serves them and compares with the hash the
// server computed at start: a mismatch means the server is running older code than it serves
// (restart it) or the page is stale (reload it).
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Served paths of every file that decides a race. Keep in step with what the engine imports. */
export const CODE_FILES = [
  'js/rng.js', 'js/racers.js', 'js/betting.js',
  'MarbleRush2D/js/engine2d.js', 'MarbleRush2D/js/track2d.js', 'MarbleRush2D/js/sectionStats.js', 'MarbleRush2D/js/detcheck.js',
];

/** SHA-256 over "path NUL bytes" for each file, first 16 hex characters. Browser and server compute it identically. */
export async function codeHash(root) {
  const h = createHash('sha256');
  for (const f of CODE_FILES) { h.update(f + '\0'); h.update(await readFile(path.join(root, f))); h.update('\0'); }
  return h.digest('hex').slice(0, 16);
}

/** The git revision of the code, with +dirty when those files differ from it, so a memo says what really raced. */
export function gitRev(root) {
  try {
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const rev = git('rev-parse', '--short=8', 'HEAD');
    return git('status', '--porcelain', '--', ...CODE_FILES) ? rev + '+dirty' : rev;
  } catch { return 'nogit'; }
}
