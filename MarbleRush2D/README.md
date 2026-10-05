> Project overview, setup and the Solana layer: see the [root README](../README.md). This file is about the 2D engine and its QA tools.

# MarbleRush 2D

The 2D build. Same product, parimutuel marble racing, back a marble, share
the pool, on a canvas instead of WebGL.

```bash
MR_ROOT="$PWD" python3 tools/serve.py          # or MR_PORT=8000 to match the brief
```

| URL | Loads |
|---|---|
| `http://localhost:8080/?v=2D` | this 2D game |
| `http://localhost:8080/?v=3D` | the original 3D game |
| `http://localhost:8080/` | 2D (the default) |
| `http://localhost:8080/?map=...` | 3D, untouched, the section benches still work |

---

## Why 2D

Hand-authoring 3D sections was the bottleneck. A 3D section had to emit swept
meshes **and** a matching collision representation, in deck-local coordinates,
on a deck that might run either direction, with triangle winding and basis
handedness both able to betray you silently.

A 2D section emits **line segments and circles** into a y-band. That is the
whole contract. Two consequences, both large:

- **A circle against a line segment has no corners.** The closest point on a
  segment moves continuously, so there is no discontinuity for a marble to
  lodge in. The 3D build lost days to cannon-es box corners, raked walls,
  clearance rules, dense sphere chains, and that entire class of bug is gone.
- You can read a section's geometry off the screen and change it without a
  solver surprising you.

Measured: **300 random courses, 300 finishers, 0 DNF, 2 races with any nudge.**
The 3D build has never been close to that.

---

## Layout

```
MarbleRush2D/
  index.html            the page
  css/style.css         HUD
  js/engine2d.js        THE RACE. Deterministic, headless, no DOM.
  js/track2d.js         section library + seeded course assembly
  js/render2d.js        canvas drawing. Reads the engine, never writes to it.
  js/main2d.js          boot, phases, betting, render loop
  tools/simulate2d.js   headless races + the section bench
  tools/probe2d.js      where a course traps marbles
  tools/fairness2d.js   is it fair, and does every race finish
```

Shared with the 3D build, imported from `../js/`, **not copied**:
`rng.js`, `racers.js`, `betting.js`. Betting is money logic and must have
exactly one implementation; a second copy is a second place to fix a payout bug.

---

## Betting

Top 2 paid, **75 / 25** of the net pool (`PLACE_SHARES` in `js/betting.js`).
At roughly even money that is ~3.56x for the winner, ~1.19x for the runner-up.

Shares, **not multiples**. A parimutuel pot is fixed at
`totalPool * (1 - rake)`, so a position pays what its share divides into. It
cannot promise "your stake back", if enough money sits on that marble there is
not enough pot. A consequence worth knowing: **placing can still lose money** if
the marble is heavily backed, and the UI reports that honestly.

An unbacked paying position has its share redistributed to the positions that
do have backers. Only if no paying position was backed is the round void.

## The race is decided before it is shown

When a round opens, `betting.js` publishes a commitment for the seed.
`main2d.js` then runs the **whole race headlessly** from that seed and keeps the
result. The animation is a second run of the same deterministic engine, and
settlement uses the stored result, not whatever was drawn.

The 3D build never had this, it simulated its own race for display and settled
from that. Moving this server-side is now only a question of *where*
`precompute()` runs.

`enterFinished()` compares the drawn order against the committed one and logs
loudly if they differ. That check has already earned its place: see the log for
2026-09-21.

---

## Adding a section

Write one function, add one line to `SECTIONS` in `track2d.js`. It is then in
the random pool, and benchable on its own:

```bash
node MarbleRush2D/tools/simulate2d.js --bench            # every section alone
node MarbleRush2D/tools/simulate2d.js --only pegs --races 5
node MarbleRush2D/tools/probe2d.js --only bowl,sprint    # where it traps
node MarbleRush2D/tools/fairness2d.js --races 300        # bias + DNF sweep
```

A good section is 5/5 finishers at **0 nudges**. All twelve currently are.

### The library

| id | Name | From | What it does |
|---|---|---|---|
| `chutes` | The Grooves |, | alternating ramps, the long opener |
| `pegs` | Pinball Alley |, | staggered bumpers; chaotic mixing |
| `bowl` | The Bowl | video 42s | ring + island; **reverses places** |
| `spiral` | The Spiral | video 42-48s | tighter ring, bigger island |
| `splitter` | The Fork |, | rounded nose splits the field two ways |
| `stairs` | The Cascade |, | short ledges; rewards carried speed |
| `combs` | Comb Grooves | video 24s | parallel channels; a lane sorter |
| `serpent` | The Serpentine | video 21s | one shared S-channel; forces single file |
| `wedges` | Wedge Field | video 09s/36s | scattered rounded wedges |
| `humps` | The Humps | video 57s | big soft domes to flow around |
| `gauntlet` | The Rails | video 15s | narrow chute; queueing and jostling |
| `sprint` | Final Sprint |, | the run-in, always last |

`?only=bowl,sprint` on the page pins the course to specific blocks.

### The rules, each learned the hard way

- **Never close the full width.** Every horizontal line needs an opening of at
  least `MIN_GAP` (96). Gravity is the only thing moving marbles, so a section
  cannot ask them to climb either.
- **Keep obstacles clear of the side walls.** `ctx.peg()` enforces this and
  refuses a peg that leaves less than `MIN_GAP`, the pocket between a peg, the
  wall and the floor swallowed a marble within an hour of the library existing.
- **Pitch every ramp above the rolling resistance.** A slope only moves a body
  when `tan(theta) > mu`. "The Grooves" at 120 over 580 froze the entire field.
- **A ring's exit must continue the ring, not cross it.** Starting the bowl's
  exit chute inside the radius put its wall-ends in the bowl interior, and that
  corner was every single DNF in a 300-race sweep.
- **Anything that settles must settle somewhere it can leave.** The bowl drain
  has to contain the bowl's lowest point, or marbles rest on solid wall forever.
- **No bare vertices.** A marble balances on a point. Both the fork nose and the
  wedge apexes had to be rounded with `ctx.dome()`; the wedges alone were 22
  stalls in 10 seeds, all at that one vertex.
- **Never space obstacles by hand.** Use `ctx.place()`, which guarantees every
  gap is at least `MIN_GAP`. Three jittered wedges across the deck closed to 64
  apart, or overlapped, and the V between two of them caught a marble in a
  fifth of all races. Two overlapping circles meet in a cusp, which traps just
  as well.
- **A ring needs something in the middle, and a feed onto its wall.** The
  entrance sits above the drain by necessity, so an empty ring is just a hole
  the field falls through. An island stops the shortcut and a one-sided feed
  ramp puts marbles onto the wall: measured 100% wall contact and 194 degrees
  of travel, against a straight drop before.
