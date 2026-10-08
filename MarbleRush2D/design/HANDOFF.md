# MarbleRush UI build brief (for Claude Code)

Written 2026-10-07. Colosseum deadline: **2026-10-12, 11:59pm PT**. Budget: about four working days, so the order below puts the screens judges see first and lists what to cut.

You are porting a finished design into the existing vanilla HTML/CSS/JS game. The design lives in five Claude Design files (copied to `design/reference/`) plus `design/tokens.css`. Do not re-design anything. Where the design and the game disagree, the "Decisions and risks" section says which wins.

## 0. Before you touch anything

1. The belt-section work (serpentine Order Book, offset Escalator and Walkway belts, refreshed `sectionStats.js`, help-text edit, `tools/qa/beltcatch.mjs`) was **committed on 2026-10-07 as `fa618d6`**, so the tree is clean apart from `design/` (untracked). This build should not need to edit `track2d.js`, `sectionStats.js`, `engine2d.js` or `scenes2d.js` at all. Note `fa618d6` changes the engine code version print recorded in every round, which is expected.
2. Work on a branch. Commit per step below, each step leaves the game playable.
3. Baseline: run `npm run test:e2e` and note it passes. Take screenshots of the current UI at 1440x900 and 390x844 (use the built-in browser, NOT a hidden pane: a hidden pane pauses frames and prints false "drifted from server" errors, see project memory).
4. Dev server: `npm start` (plain server on :8000 serves stale modules; test on :8080 as Sanjay does, see memory `dev-server-ports`).

## 1. The design files and how to read them

| File in `design/reference/` | Covers |
|---|---|
| `betting.PARTIAL-first-256KiB.dc.html` | Frames 1 (desktop betting), 3 (mobile betting), 5 (desktop race), 7 (mobile race), 9/10 (countdown), 11a-11d (desktop results: win, place, loss, void). **Truncated at 256 KiB**: the mobile results 12a-12d, the archive and the tweaks are missing. Build mobile results from desktop results + the rules in section 7. |
| `wallet.dc.html` | W1-W6: connect, connecting, refused/not found, connected account, faucet states, header chips |
| `states.dc.html` | A01-A11: bet-dock state ladder (desktop 440px + mobile); S1-S3: signed-out spectator race and results |
| `trust.dc.html` | A1-A5: reconnecting, loading, empty, error, chain unavailable; B1-B3: round proof card; C: onboarding steps 1, 4, 5 |
| `brand.dc.html` | logo system (Hybrid pick, Drop v2, Field pattern), app icon, OG image, storyboard |

Format notes: these are Claude Design `<x-dc>` pages with `{{ }}` templating and a `support.js` runtime. **They do not run standalone.** Treat them as readable source: open them in the Claude Design preview for visuals, and read the inline `style="..."` attributes for exact sizes. Every frame carries `data-frame="..."` (e.g. `data-frame="5"`), so `grep`/slice by that. Every colour, radius, space and font size is a CSS variable from `design/tokens.css`.

## 2. Tokens, fonts, palette

- Copy `design/tokens.css` into the game (suggested: `css/tokens.css`, linked before `style.css`). Palette is `<html data-palette="ivory">` (default) or `champagne`: only `--accent*`, `--surface-accent`, `--win` differ. **Sanjay decided (R4): players choose**: build both, default `ivory`, and expose a player-facing switch (see R4, step S2b).
- `--celebrate*` is gold in BOTH palettes and is used only for winning (confetti, payout glow, winner spotlight, logo). Never use `--accent` for celebration.
- Fonts: replace the Google Fonts link (currently Inter, Sora, Barlow Condensed, JetBrains Mono) with **Instrument Sans (400,500,600)** for UI and **Barlow Condensed (500,600,700)** for all data (odds, clocks, gaps, labels in caps, tabular figures). Drop Sora, Inter and JetBrains Mono unless something still needs mono (addresses and hashes: use `ui-monospace` stack).
- Aliases: to avoid rewriting 500 lines of CSS at once, first map the old names onto the new ones in `:root` after the tokens: `--bg`→`var(--bg)`, `--text`→`--text-1`, `--muted`→`--text-2`, `--faint`→`--text-3`, `--gold`/`--accent`→`--accent`, `--stroke`→`--line`, `--stroke-hi`→`--line-strong`, `--radius`→`--r-md`, `--radius-s`→`--r-sm`, `--good`/`--bad`: keep for odds up/down arrows only. Remove aliases as you restyle.
- **Marble colours: the game and the design disagree.** `js/racers.js` `MARBLE_DATA[].hex` = #ff5a3c, #35b6f2, #49d17a, #9a6bff, #f0b429. The design's `--m-blz/frs/vnm/roy/bul` = #E0473B, #3B87E6, #36B368, #9161E3, #F5B800. Decision: **`MARBLE_DATA` stays the single source of truth** (the canvas draws from it and the HUD must match the canvas). At boot set `--m-blz...` from `MARBLE_DATA` in JS; the design values were only a close approximation. The design's contrast ratios hold or improve with the brighter game colours on the dark base.
- Glass: ONE material, one blur (`--blur`: 12px). **At most 3 `backdrop-filter` panels on screen at once**, never one blurred panel inside another. Rows, chips, cards inside panels use solid `--surface-1/2/3` fills. This is a hard rule from the brief (the canvas animates underneath).
- Spacing: padding/margin/gap multiples of 8, with 4 as the only half-step. Radii from `--r-*`. Tap targets `--tap` (44px) minimum. AA contrast (the tokens are already checked: lowest text-3 on any surface is 4.80:1). Respect `prefers-reduced-motion`.
- Marble icon in the HUD: keep the `coin(i)` helper (`js/main2d.js:31`, `.coin` with `--c`/`--d`) but restyle `.coin` as a glass marble (highlight, no rim). Never rely on colour alone: every marble row also shows the ticker and a number 1-5.

## 3. How the renderer interacts with the HUD (do not break this)

`js/render2d.js` `resize()` frames the course into whatever the HUD leaves clear:
- Every panel marked `data-hud` is measured. A panel at least 55% of the width is a **band** (top or bottom by its centre); a narrower one is a **side card** on the left or right of the centre line.
- A panel with CSS `--hud: overlay` is ignored (floats over the course on purpose).
- Call `renderer.resize()` after any layout change (existing `setRaceLayout()` does this via `body.race-on`).
- The course is a **vertical** column that scrolls down with the camera. Vertical room is precious on mobile. Rule: on phones, anything that is a top band eats look-ahead, so the mobile race classification strip (see 5.4) should be `--hud: overlay` or very short, and the bottom peek bar (88px + safe-area) is the only bottom band.
- Desktop geometry from the design (1440x900): betting = left column 344px wide at top 96, right market panel 416px at top 96/bottom 24, clock ring 176px at top-centre; race = left tower 320px wide, right stack 340px, both at top 88; camera bar bottom-centre. Today's CSS has tower 248px and rail 340px: widen them to match (`--tower-w: 320px`; rail 416px in betting, 340px in race).

## 4. State machine to UI map (existing code to design)

Phases in `main2d.js`: `BETTING → READY → COUNTDOWN → RACING → FINISHED`, in net mode also driven by `onNetRound/onNetSync/onNetSettled` (server clock). Body classes already toggled: `race-on`, `racing`, `net`. Keep them; hang the new layouts off them.

`renderBetButton()` (`main2d.js:716`) is the single place that sets the CTA label. Map to the design's ladder (A01-A11), keeping button id `placeBet` and its disabled/onclick logic:

| Existing code path | Existing label | Design state / new label |
|---|---|---|
| `betting.guest` | Connect wallet to play | A08 "Connect wallet to play" |
| `betting.sealing` | Sealing round on Solana… | A10 "Sealing round on Solana…" + proof pill animating |
| `betState = preparing` | Preparing your bet… | A03 "Preparing your bet" + 3-step bar (Prepare, Approve, Confirm) |
| `betState = signing` | Approve in your wallet… | A04 "Approve in Phantom" (use the connected wallet's name) + Cancel link (44px) |
| `betState = confirming` | Confirming on Solana… | A05 "Confirming on Solana" (indeterminate progress) |
| `betting.placed` | READY | A06 "Bet placed" + check, **button greyed out and disabled**, stake and marble shown. NO "change your bet" line (see R1: the bet is locked once sent) |
| balance < minBet (token) | Get test {TOKEN} to play | A07 "Get test token" CTA (opens wallet faucet row), line "Balance 4.00 RUSH, minimum 10" |
| `betting.selected < 0` | Select a marble | A01 "Pick a marble" (disabled) |
| ready | Bet {stake} → {payout} | A02 (the single bright call to action, 56px high, breathing glow only in this state) |
| phase not BETTING | Betting closed | A09 "Betting closed · next round in m:ss" + "Your bet on {marble} stands · {stake}" |
| bet refused / tx failed (`error` callback) | banner text | A11a "Bet not placed" (outlined, NOT red, "NOT PLACED" tag, reason, Try again) |
| void round refund | n/a | A11b "Stake returned · {amount} {TOKEN}" with refund link |

The CTA is 56px high in every state and the stake chips (48px) above it never move: keep the dock a fixed height.

## 5. Per screen: what changes, ids to keep, ids to add

Existing ids are in `index.html`. **Keep every existing id** (JS binds to them) unless a row says "replace". New ids to add are marked NEW.

### 5.1 Top bar (all phases)
Keep: `roundTag`, `phaseLabel`, `raceClock`, `livePill`, `fairLabel`, `commitment`, `balance`, `walletBtn`, `helpBtn`. Wrapper `.topbar[data-hud]`, `.brand`, `.clock`, `.right`, `.fair`, `.wallet` keep.
- Replace the `.logo` span + `<h1>` with the **Hybrid lockup** (SVG from `brand.dc.html`, A3; compact Drop v2 at ≤32px) and add a **DEVNET** badge next to the round tag (P1, honest test-money signal).
- Proof pill (`.fair`): states Sealing / Sealed / Verified on Solana already come from `renderFair()`. Design makes it prominent and opens the **proof card** (5.9) on click instead of opening the explorer directly (the card links to both transactions). Add a dashed neutral "Not sealed on Solana" state for chain unavailable (5.8).
- Wallet chip: signed out = accent "Connect" button; connected = avatar + `4Pc3...XpsA`; low balance (< minBet) shows a dot plus the text tag **LOW** (never the dot alone). Desktop only; on mobile the chip is display-only and Connect lives on the CTA / spectator bar.
- Mobile (<=900px): brand mark only + clock + balance + help; the proof pill collapses to its shield icon but keeps a 44px target.

### 5.2 Betting phase, desktop (frame 1)
- Left column (344px, `data-hud`, side card): proof card summary ("Sealed on Solana · 3f9a...c21", Verify seal button) and the **live bets** card (`feed`, `feedCount`; whale flag chip).
- Centre: the real canvas course framed by the renderer, plus a **vertical progress rail** with event markers along the column (see 5.5 for the engineering note). The betting-phase course preview shows the start gate with marbles stacked.
- Clock: large ring, 176px, top-centre: replace the `lobby` bar. Keep ids `lobby`, `lobbyClock`, `lobbyLabel`, `lobbyFill` (ring is driven from `lobbyFill`'s value; set a CSS variable on `#lobby`).
- Right panel (416px, `#rail`/`#totePanel`): header "Market · Top 2 paid · Pool", five rows (`#tote`, built in `renderTote()`): marble, ticker + number, **win odds large**, runner-up odds, pool-share bar, backers; selected row highlighted. Below: stakes (`#stakes`, 48px chips), `#placeBet` (56px), fineprint (`#rakePct`). Recent races (`#history`) and record (`#record`) are P2: collapse them under a "Form guide" disclosure.
- Remove the side cam from betting (it is race-only).

### 5.3 Betting phase, mobile (frame 3)
- Course preview behind, clock ring 128px at top-centre, proof pill + DEVNET under it.
- **Bottom sheet** (`#rail` becomes the sheet), three snap states: peek (88px + safe-area), half, full, with a drag handle. In betting it opens at half: five market rows (win odds large; runner-up and backers appear on the tapped row), stake chips and the CTA in one thumb-zone block, CTA clears `env(safe-area-inset-bottom)`.
- One-line "latest bet" peek above the sheet (the feed): full feed and form guide one swipe up.
- Every control in the bottom 40% of the screen; the top of the screen is display-only.

### 5.4 Countdown (frames 9/10)
Keep `countdownOverlay`, `gantry`, `countdownValue`, `countdownNote`. Gantry changes from 5 lamps to **3 ivory lamps** (3-2-1), lit one per second, **lights OUT at GO** (instant). Number is huge (`--fs-6xl`). Note text: "Marbles in the gate". HUD dims to the edges; hide the tower; one chip **"Riding {marble} · {stake} {TOKEN}"** (NEW id `ridingChip`). Mobile: sheet collapses to the 88px peek bar containing the same chip. Short haptic tick per second on mobile (`navigator.vibrate(10)`, skipped under reduced-motion).

### 5.5 Race (frames 5 and 7)
Keep: `standings`, `standingsPanel`, `sectionName`, `banner`, `courseMap`, `cmMarks`, `cmDots`, `camBar`, `camCoins`, `camWhy`, `leaderCam`, `camName`, `board`.
- Tower (`#standingsPanel`, 320px): row = position block, team stripe, marble, ticker, gap or **OUT** (text). The user's own row is highlighted (NEW class `.mine`) and tagged "MINE". Header shows `sectionName`.
- **My marble card** (NEW id `myMarble`), top of the right stack, P0: "P2 · Frost running 2nd", bet stake, and two lines: "1st would pay X · 2nd pays Y" (compute from `betting.quote`, see `net2d.js` `quote`/payout helpers; these must match what settlement pays). Tapping it makes the camera follow my marble (set `camBar` to that marble; show a "FOLLOWING" state and a release tap).
- Right stack below it: side cam (`leaderCam`, collapsible, P2), then a compact "Final pool and odds" list (betting is closed, P2).
- Race control banner (`#banner`, `announce()` in `main2d.js:525`): drops from top-centre of the course column, bold condensed caps "EVENT HORIZON · Royal swallowed" style. Keep the 3.2s timer. Do not remove the existing `OUT_WORDS` copy, just restyle.
- Camera bar (`#camBar`, `buildCamBar()`): Auto / Pack / Leader + one dot per marble (with number), bottom-centre desktop; chips above the peek bar on mobile (never inside the 88px peek bar).
- **Course progress** (`courseMap`): today a horizontal strip inside the tower. The design draws a thin **vertical rail** hugging the left wall of the course column, with labelled event markers (Gate, Hairpin, Jump, Funnel, Finish) and each marble's dot. This is the one non-trivial engineering item: position the rail from the renderer's computed course rect (add a small `renderer.courseRect()` returning screen-space x/y/height of the column), re-run on `resize()`. Cheaper acceptable fallback if time runs out: keep it a vertical rail pinned at `renderer.safe.x` (left edge of the clear area). Existing `buildCourseMap()`/`renderCourseMap()` already compute marker positions.
- Mobile race (frame 7): course fills the screen; the bottom 88px **peek bar** (NEW id `peekBar`) always shows "Frost running 2nd · Bet 50 · 1st pays X" and is the only bottom band; classification is a slim display strip under the top bar (make it `--hud: overlay` or <=56px, see section 3); camera chips just above the peek bar; the sheet is **locked at peek** during the race (the old `body.race-on .rail { display:none }` rule goes away; the sheet persists as the peek bar). Pulling the sheet up in the race is NOT supported by the design.
- Wake lock: `navigator.wakeLock.request('screen')` while `body.racing`, release on finish; feature-detect.

### 5.6 Results (frames 11a-11d; mobile per section 7)
Keep: `resultOverlay`, `podium`, `winName`, `winTime`, `winSwatch`, `payout`, `finalOrder`, `koReplay`, `koCanvas`, `koLabel`, `nextRace`, `nextNote`, `burst`, `confetti`. The overlay stops being a centred modal card: the **course stays visible** (camera on the finish) with panels around it.
- Common: top pill "Round paid out on Solana · 5Qx...9aB" (round-level; link to explorer; this is the existing payout banner text moved up), podium (2nd, 1st, 3rd) with times, full finishing order (left panel, 320px, OUT rows), "Round proof" link (opens proof card), knockout replay tile (`koReplay`, P2, only when a knockout happened), and the **next-round ring**: "Betting opens in 6s" (replace `nextRace` button as the primary element; keep the button for skipping).
- Personal panel (right, 340px), driven by `settleInfo` in `showResult()`:
  - WIN (`settleInfo.place >= 0 && profit > 0`): "1st · Frost", payout, profit "+119.90", odds "3.4x", gold `--celebrate` card border/glow, payout count-up (1.3s, existing code), confetti recoloured to `--celebrate`, spotlight on the winner marble. Full celebration.
  - PLACE (placed, profit may be small or negative): "2nd · Frost", "Runner-up pays", quiet glow, a few particles, NO full confetti. Sign the figure off the PROFIT as the existing code does (a placed marble can still lose money; do not say otherwise).
  - LOSS (`settleInfo.backed >= 0`, no place): "Not this time", payout 0.00, profit "−50.00", one line "{Winner} won at {odds}", NO confetti, NO red, grey figure; the next-round ring is the hero.
  - VOID (`settleInfo.void`): neutral panel "Round {n} was voided. Your stake was returned.", "+50.00 returned", profit 0.00, refund tx link, podium replaced with "No result". Banner says "Refunded on Solana".
  - No bet / signed out: "You watched this round" (+ Connect wallet in the pinned bar on mobile, see 5.7).
- Paid-out link: show the **personal** "Paid out on Solana ↗" link only on WIN and PLACE (existing `payout` callback in the net boot block).
- Keep `launchConfetti()`; only change colours/density. Reduced motion: no particles, no count-up animation, a static glow.

### 5.7 Wallet, faucet, spectator (wallet + states files)
`openWallet()` (`main2d.js:1150`) builds `#walletCard` with `innerHTML`; rewrite its templates, keep `walletOverlay`, `walletCard`, ids `walletOut`, `walletClose`, `walletErr`, `walletTokens`, class `.walletopt[data-w]`, `loadTokenRows()`.
- Desktop: centred modal card 440px; mobile: bottom sheet with drag handle. Both close on backdrop click (existing).
- W1 connect: title "Connect a wallet to play"; rows Phantom / Solflare / Backpack (detected = chevron, not installed = "Install ↗" link from `WALLET_LINKS`); secondary "Watch without a wallet". **Keep the existing precise sign-in copy**: "Sign a free message to play. It sends no transaction, costs no fee and gives us no access to your funds." and add "Players never need SOL: bets are signed token transfers" (gasless is a server fee-payer decision, see memory). No real wallet logos: simple glyph circles.
- W2 connecting (spinner + Cancel), W3 refused/not found (error line + "Try again" + "Choose another wallet"): drive from the `signIn` promise state and `e.message`.
- W4 connected: shortened address + copy + DEVNET badge, balances per token (`loadTokenRows()`: the round's token tagged "THIS ROUND"), a faucet row per token with a zero balance (`/api/faucet`), Copy address and Disconnect (bottom, thumb zone).
- W5 faucet states: idle, requesting, success ("+100 RUSH"), cooldown ("Next in 04:12": needs the server to return a retry time; if it does not, show a generic "Try again later"), failed (retry).
- Spectator (states S1-S3): when `betting.guest`, replace My marble with "Watching · Connect a wallet to play the next round" + Connect (desktop: also in the header chip; mobile: in the peek bar and, in results, in the pinned bar next to the next-round countdown). A signed-out player must always have a thumb-zone Connect in every phase.

### 5.8 System states (trust file, section A)
- **Reconnecting**: `net2d.js:109` already fires `on.status('reconnecting')` on SSE error. Add the inverse (`'connected'`) on `es.onopen` if missing. UI: slim banner "Reconnecting… the race keeps running here", panels dim and get a PAUSED tag; on recovery a 2-second "Reconnected" confirmation.
- **Loading**: skeleton rows (40px, market 5 rows, tower 5 rows, feed) until the first round/sync arrives. No big spinners.
- **Empty**: live bets "No bets yet · Be the first"; recent races "No races yet"; new wallet "0.00 RUSH · Get test token".
- **Error**: full-panel "Can't reach the server" + OFFLINE tag + Retry; inline "Couldn't load recent races · Retry" for single failures.
- **Chain unavailable**: when the round has no confirmed commit (`betting.chain` absent/failed), proof pill becomes the dashed neutral "Not sealed on Solana", bets disabled with "Chain unavailable · watching only", line "This round cannot be verified on-chain."
- Copy correction (see R3): the design's error panel says "Your bets and balance are safe on Solana." Change to **"Your balance is on Solana. We'll keep trying in the background."**

### 5.9 Proof card and onboarding (trust file, sections B and C)
- **Proof card** (NEW `#proofOverlay`/`#proofCard`, modal 440px desktop, sheet on mobile). Opened from the proof pill and from "Round proof" on results. Rows: Round, Token, status ("Verified on Solana" ✓), Commit hash (copy), Course seed (copy; before reveal show "Revealed after the race"), Commit tx and Reveal tx (explorer links via existing `explorer(sig, cluster)`), one plain sentence, primary "Replay it yourself", and a "For developers" copyable command: `npm run verify-round -- <revealSig>` (the repo script is `tools/verify-round.mjs`; the design shows `node tools/verify-round.mjs <sig>`: use the real path). Three states: sealed (before reveal), verified (after), unanchored. "Replay it yourself" is disabled before the reveal.
- **Onboarding** (replace the body of `#helpOverlay`, keep ids `helpOverlay`, `helpBtn`, `helpClose`): a 5-step stepper (dots, Skip, Back, Next, last "Got it"): 1 Back a marble, 2 Beat the clock (about 30s, **drop the "Ready up" rule entirely**), 3 Every course is new (fold "machines wear", "chaos", "knockouts" into one friendly card), 4 Top two are paid (75/25 after 5% rake; the design's worked example for a 1,240 pool is 883.50 / 294.50, correct: 1,240 × 0.95 = 1,178, then 75% = 883.50 and 25% = 294.50), 5 Provably fair + "Devnet test money. No real funds." Steps 2 and 3 were not drawn: reuse the step layout. First visit: auto-open once (localStorage flag, wrapped in try/catch) and pulse the help chip once. Mobile: bottom sheet.

### 5.10 Brand (brand file)
- Logo: **Hybrid** (four small marbles in a V above a larger glass leader) full at ≥64px, simplified dots at 33-63px, **Drop v2 compact** at ≤32px; wordmark Barlow Condensed with "Rush" in `--celebrate`. Read the SVG markup from `brand.dc.html` (A3, A1 compact).
- App icon / favicon: Drop v2 on the dark base (1024, 180, 64, 32, 16): export SVG/PNGs to `ui-assets` or a new `assets/` folder; add `<link rel="icon">`, `apple-touch-icon`, and OG/Twitter meta tags to `index.html` (OG 1200x630 is drawn in `brand.dc.html`; render it to PNG, tagline "Back a marble. Watch it drop.").
- Known design nits Sanjay may still polish (non-blocking): the ribbon inside the leader marble reads as a pinwheel, the gold rim is heavy, the leader could be about 30% larger.

## 6. Implementation order (each step ends playable and committed)

| Step | What | Done when | If short on time |
|---|---|---|---|
| S1 | tokens.css, fonts, aliases, marble colours from `MARBLE_DATA`, restyle `.coin`, buttons, glass | game looks re-skinned, no layout change, e2e passes | must do |
| S2 | Top bar + proof pill + Hybrid lockup + DEVNET badge + wallet chip | desktop + mobile header match frames | must do |
| S2b | Palette switcher (Ivory | Champagne) per R4, persisted, no flash | switch works, survives reload, `?palette=` works | must do (small) |
| S3 | Race HUD desktop: tower 320, My marble card, right stack, banner, camera bar, vertical rail (fallback allowed) | frame 5 matches at 1440x900 | must do (judges watch the race) |
| S4 | Betting desktop: left column, ring clock, market panel, CTA ladder A01-A11 via `renderBetButton()` | frame 1 + every CTA state reachable | must do |
| S5 | Countdown + results (4 outcomes), confetti recolour, next-round ring | frames 9, 11a-d | must do |
| S6 | Mobile: betting sheet, race peek bar + top strip, results sheet, safe-area, wake lock | frames 3, 7 and results at 390x844 | must do |
| S7 | Wallet modal/sheet, faucet states, spectator cards | wallet frames W1-W6, S1-S3 | do W1/W4 and the spectator Connect; defer W5 cooldown |
| S8 | Brand: favicon, app icon, OG meta | tab icon + share preview | do favicon and OG only |
| S9 | Proof card + onboarding stepper | frames B and C | proof card first (core claim); onboarding can stay the old help text with the "Ready up" row removed |
| S10 | System states: reconnecting, error, chain unavailable, then loading and empty | frames A1-A5 | reconnecting + chain unavailable first |

Do not start the partner-show skin or the track-machine art: both are deferred (no design exists).

## 7. Mobile results (frames 12a-12d are not readable from the partial file)
Rules from the approved prompt and the notes in the file: the bottom sheet becomes the **result card**, payout first (the personal outcome as in 5.6), then the podium (top 3 with times), then the finishing order with **24px rows**; the knockout replay tile is NOT in the default sheet state (a small "Pull up · knockout replay" label under the drag handle points to it); the next-round countdown and, for spectators, Connect sit in a bottom bar pinned in the thumb zone above the safe area; the race stays visible above. Loss and void use the same layout, muted, no confetti. Snap states: peek / half / full as in 5.3.

## 8. Decisions and risks (read before building)

- **R1: when a bet can still be changed (DECIDED by Sanjay 2026-10-07).** The player may change the marble and the stake freely **until they press the Bet button and send the transaction**. After that the bet is final: the CTA goes grey and disabled ("Bet placed"), the market rows and stake chips lock, and nothing can be changed or cancelled. This matches how the code already works for a placed bet (`renderTote` sets `locked` when `betting.placed`); a bet is a signed token transfer, so there is no change-bet, no refund-and-replace. The design's A06 line "Change your bet until the clock ends" is therefore **wrong: delete it** from the Bet placed state and from the onboarding step 2 text ("one bet per round, locked once sent"). One gap to close: `locked` is currently only set after `placed`, but a bet is in flight during `betState` = preparing / signing / confirming; **lock the rows and stake chips for the whole in-flight window too**, so nothing changes under the wallet popup. If the signature is cancelled or the bet fails (A11a), unlock everything and keep the player's marble and stake selected ("Your stake and pick are kept").
- **R2: READY / "Ready up".** The old flow has a `READY` phase and `betting.sendReady()` in net mode. Rounds are now shared and run on the server clock, and Sanjay confirmed dropping "Ready up". Checked in `server/server.mjs:683`: `/api/ready` only lets the lobby close EARLY when every connected player has readied and bet; otherwise the round starts on the server clock. So **removing the READY button is safe**: the round always starts on time. Remove the READY button and wording from the UI, do not auto-send ready (keep the full ~30s betting window so the "one shared show" timing is predictable), and keep `enterReady`/`sendReady` in the code untouched but unreachable from the UI. A placed bet shows "Bet placed" (A06).
- **R3: honest copy.** Do not say bets are "safe on Solana" (a bet is settled by the server payout job, not by chain finality). Use the corrected error copy above. The top-of-results pill says "Round paid out on Solana"; the personal "Paid out" line appears only when the player was actually paid.
- **R4: palette (DECIDED by Sanjay 2026-10-07): let each player choose.** Ship both palettes with a visible control: a small "Appearance" row with a two-option segmented control **Ivory | Champagne**, placed in the footer of the wallet card (signed in and signed out) and repeated at the end of the onboarding sheet. Default Ivory. Persist the choice in `localStorage` (key `mr.palette`, every access wrapped in try/catch, the page must work without it) and apply `document.documentElement.dataset.palette` from a tiny inline script in `<head>` BEFORE the stylesheet paints, so there is no flash of the wrong palette. Also honour `?palette=champagne|ivory` in the URL (handy for screenshots and the demo video). The canvas course and marbles do not change with the palette; only the UI accent tokens do. Add this as step **S2b** (small, after the top bar).
- **R5: measurements in the design files** (`{{ mt.x }}` placeholders) are computed by Claude Design at load: ignore them. Verified separately: no button under 44px in any file, `--text-3` (#A69D91) ≥4.80:1 on every surface, no hardcoded colours outside tokens.
- **R6: copy facts** the UI must not invent: odds and payouts come from `betting.quote()` / `settleInfo` only; the design's 169.90 / 61.20 / 3.4x figures are illustrative. Token symbol is dynamic (2-6 chars), amounts have 0-2 decimals, addresses are always shortened `4Pc3...XpsA`.
- **R7: placeholder data** in the design (marble backers, pools, tx hashes like `5Qx...9aB`) is fake. Real values come from the existing state objects.

## 9. Acceptance checklist
- [ ] `npm run test:e2e` still passes; `npm run test:chain` unchanged (needs devnet: skip if unavailable and say so).
- [ ] Screenshots at 1440x900, 768x1024 and 390x844 for each phase (betting, countdown, race, results win/place/loss/void) match the frames; also a short landscape phone (844x390) race screen is usable.
- [ ] The vertical course is framed correctly in every phase (check the renderer safe area after each layout change).
- [ ] Never more than 3 blurred panels on screen; no layout shift in the CTA dock; all taps ≥44px; AA contrast; reduced-motion honoured.
- [ ] Every existing id in `index.html` still resolves (grep each `$('id')` in `js/main2d.js` against the new HTML).
- [ ] Bet lock (R1): marble and stake changeable until Bet is pressed; rows, chips and CTA all locked while preparing/signing/confirming and after the bet is placed (grey, disabled); a cancelled or failed bet unlocks and keeps the selection.
- [ ] Palette switch (R4) works in both palettes on every screen, persists, and does not flash on load.
- [ ] Signed-out spectator can connect from every phase; devnet badge visible; proof pill opens the proof card.
- [ ] Nothing in `engine2d.js`, `track2d.js`, `scenes2d.js`, `sectionStats.js` changed by this work.

## 10. Backlog after the port (2026-10-08)
- [ ] "Replay it yourself" re-runs the race in the browser from the revealed seeds and shows "Re-ran the race · same finishing order ✓" next to the hash check (the engine is already in the page; 1-2 h).
- [ ] Race lengths: Sprint ~1 min, Classic ~3 min, Marathon ~4 min. Rotation on the shared server ("Up next: Sprint" on the results card), a next-race picker in local practice mode; no separate home page before the hackathon. Each length needs a soak (stuck marbles, drama).
- [ ] `og:image` / `twitter:image` to an absolute URL once the domain is known.
- [ ] Run `npm run test:chain` on main (covers the S10 watch-only round refusal).
- Decided: no tablet layout (768 uses the phone layout).
