// The only parts of @solana/web3.js the browser needs: rebuild a transaction the server
// prepared, so the wallet can sign it. Bundled by tools/build-vendor.mjs into solana-web3.js.
export { Transaction } from '@solana/web3.js';
