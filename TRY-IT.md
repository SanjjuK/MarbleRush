# Try MarbleRush on Solana devnet (about 3 minutes)

MarbleRush is a live marble race you can bet on. It runs on Solana **devnet**, a test network. Nothing here has real value: the tokens are free test tokens and you never need SOL.

**Before you start:** use a wallet with nothing important in it, or make a new one in Phantom (profile icon, then Add account). MarbleRush never asks for your seed phrase, and nobody connected to it ever should.

## 1. Switch Phantom to Devnet

**Browser extension (desktop)**
1. Open Phantom and click the **gear icon** (Settings).
2. Go to **Developer Settings**.
3. Turn on **Testnet Mode**.
4. Pick **Solana Devnet** from the network list.

**Phone**
1. Open the Phantom app, go to Settings, Developer Settings, Testnet Mode, and choose Solana Devnet.
2. Open the game link in Phantom's **built-in browser** (the Browser tab). Browsers outside the app cannot see your wallet.

Menu names can differ slightly between Phantom versions.

## 2. Open the game

**https://34-29-110-88.sslip.io/MarbleRush2D/**

If a short tour appears, click through it or press Skip.

## 3. Connect and get test tokens

1. Click **Connect** (top right) and choose **Phantom**.
2. Phantom asks you to **sign a message**. This is free and only proves the wallet is yours. It is not a transaction.
3. Open your wallet panel (your address, top right) and take your free **RUSH** test tokens. You do not need any SOL: the game pays the network fee.

## 4. Place a bet

1. The Practice round starts as soon as you are connected, and you have **60 seconds** to bet.
2. Click a marble, pick a stake (10, 25, 50 or 100) and press **Bet**.
3. Phantom shows one small token transfer. Approve it. Your bet then appears in the Live Bets list.
4. Bets close 4 seconds before the gates open, so do not wait for the last moment.

## 5. Watch the race

- The race lasts about 3 to 4 minutes and has sound. Click once anywhere on the page so the browser lets it play; the speaker button in the top bar mutes it.
- The top two marbles are paid 75% and 25% of the pool after a 5% fee. Your payout arrives in your wallet a few seconds after the result.

## 6. Check the race was fair (optional)

Click the **Sealed on Solana** pill, then **Round proof**. It links to the two Solana transactions: one posted before betting and one after the race. Anyone can replay the race from them:

```bash
node MarbleRush2D/tools/verify-round.mjs <reveal transaction signature>
```

More: [the blockchain layer](BLOCKCHAIN.md), [FAQ](FAQ.md).

## If something goes wrong

- **"Wallet not found":** install Phantom, reload the page. On a phone use Phantom's built-in browser.
- **Phantom warns about the network, or the bet fails:** check Phantom is on **Solana Devnet** (step 1).
- **Nothing happens when you connect:** reload the page and connect again. A Practice round starts only after a wallet is connected.
- **"Betting is closed":** wait for the next round, which starts about 10 seconds after the result.
- **When you are done:** turn **Testnet Mode** off in Phantom to go back to your normal network.
