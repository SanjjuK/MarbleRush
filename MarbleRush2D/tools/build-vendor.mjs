// build-vendor.mjs: bundle the one piece of @solana/web3.js the page uses into a single
// file served from our own origin (no CDN script on a page that handles wallets).
//   node MarbleRush2D/tools/build-vendor.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(HERE, '..', 'js', 'vendor', 'web3-entry.js')],
  outfile: path.join(HERE, '..', 'js', 'vendor', 'solana-web3.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  inject: [path.join(HERE, 'buffer-shim.js')],
  legalComments: 'none',
});
console.log('built js/vendor/solana-web3.js');
