# Probability Poker

[![CI](https://github.com/shardulmarathe/Probability-Poker/actions/workflows/ci.yml/badge.svg)](https://github.com/shardulmarathe/Probability-Poker/actions/workflows/ci.yml)

> Can probability outperform human intuition?

**[Play it →](https://probabilitypoker.vercel.app)**

An educational, probability-focused **No-Limit Texas Hold'em** table for 2–6
seats, built for a Stanford probability course. You play against bots that make
every decision from a **Bayesian range model over all 1,326 hole-card
combinations**, **multiway Monte Carlo equity**, and **expected value with fold
equity** — then review the hand in a dashboard that shows the derivation of
every number.

A separate module solves small games to Nash equilibrium with **Discounted CFR**
and checks itself against known answers: Kuhn poker's analytic game value of
−1/18, and published heads-up push/fold charts (1005 of 1014 cells).

Every hand is dealt from a seed, so a hand replays exactly from that one number
and the whole test suite is deterministic.

The full derivation of the mathematics lives in
[`TECHNICAL_WRITEUP.md`](./TECHNICAL_WRITEUP.md).

## Tech stack

- **React 19** + **TypeScript**
- **Vite** (dev server + build)
- **Tailwind CSS v4**
- **Recharts** (charts)
- **Neon** (Postgres) behind serverless functions in `api/`, for accounts and
  saved hands. The engine itself is pure client-side TypeScript with no network
  call on the decision path.

## Getting started

```bash
npm install
npm run dev        # start the dev server (http://localhost:5173)
npm run build      # typecheck + production build
npm run preview    # preview the production build
npm test           # run the engine test suite
npm run typecheck  # tsc -b --noEmit
```

Equity simulation runs in a Web Worker pool, with an in-process fallback when
workers are unavailable. The numbers are identical either way: the run is split
into a **constant** four shards regardless of core count, and shards are merged
by integer addition in shard order, so a 2-core and a 16-core machine agree bit
for bit.

## Routes

| Route | What it is |
| --- | --- |
| `/table` | The 2–6 seat No-Limit table |
| `/review` | Hand review — timeline, ranges, EV table, the full derivation |
| `/replay/:seed` | Replay any hand from its deal seed, with counterfactuals |
| `/profile` | Your archive and playing-style statistics |
| `/learn` | The probability concepts, worked with live engine calls |

## The probability concepts on display

| Concept | Where it lives |
| --- | --- |
| **Ranges & card removal** | `Float64Array(1326)` per opponent; blockers fall out of `removeCards` (`src/poker/model/range.ts`) |
| **Board-relative hand classes** | 9 classes ordered by measured equity, audited with Earth Mover's Distance (`src/poker/model/buckets.ts`, `model/distribution.ts`) |
| **Conditional probability** | `P(action \| bucket, street, position, facing)` — 648 cells (`src/poker/model/likelihood.ts`) |
| **Bayesian inference** | Belief updates and range reweighting (`src/poker/bayesian.ts`, `model/decider.ts`) |
| **Hierarchical shrinkage** | Six-level backoff with inclusion–exclusion, so each observation counts once (`src/poker/model/likelihood.ts`) |
| **Monte Carlo simulation** | Multiway equity by whole-tuple rejection sampling (`src/poker/equity/multiway.ts`) |
| **Interval estimation** | Wilson score intervals, not `p̂ ± 1.96·SE` (`src/poker/core/stats.ts`) |
| **Expected value & fold equity** | `EV(bet s) = P(fold)·Pot + (1−P(fold))·[E_continue·(Pot+2s) − s]` (`src/poker/ev.ts`) |
| **α and MDF** | `α = s/(P+s)`, `MDF = 1−α`, derived and pinned against published values (`src/poker/ev.ts`) |
| **Game theory** | Discounted CFR and exact best-response exploitability (`src/poker/solver/`) |

## How the bots think

1. **Build a range for every opponent.** Start flat — before anyone acts, every
   combo the deck allows is equally likely — then multiply each combo by
   `P(action | bucket(combo), street, position, facing)` for every action on the
   public record, with the hand class measured against the board *as it stood on
   that street*. Card removal is applied once up front, so blockers are free.
   The bots read only public information; no seat's cards are consulted.
2. **Estimate equity against the whole field.** The hero must beat *every*
   opponent, and a k-way chop is worth 1/k — so what drives EV is `equity`, not
   `P(win)`. The field is drawn as one tuple and redrawn whole on a collision,
   which is what keeps the sampler symmetric in seat order.
3. **Price every action, and every size.** Checks, folds and closing calls are
   priced on the pot as it stands. Bets and raises are priced with fold equity,
   once per rung of the sizing ladder, against the range that *continues* rather
   than the whole range. Calls that don't close the action are re-priced against
   the pot the seats behind will build, on the same basis a raise is priced —
   otherwise the two aren't comparable.
4. **argmax, then personality.** Seven archetypes — from Nickel Nate (nit) to
   Wildfire Wes (maniac) — bend the pure-EV answer with entry discipline, bluff
   frequency and an aggression tilt. The record shows both the EV table and what
   the profile actually did.
5. **Learn from you.** Finished hands are folded into a likelihood model scoped
   to your seat alone. Folded hands still teach — they write to the two hand-class-free
   levels of the backoff, which compresses the likelihood ratio between hand
   classes rather than sharpening it. Over 60 hands against a scripted bluffer,
   the bots' `P(bet | air)` moves 0.136 → 0.553 and the air share of their read
   on that seat moves 34% → 89%.

## Project structure

```
src/
  components/   table, hand review, profile, learn pages
  data/         tunable constants (priors, likelihoods, smoothing)
  lib/          table options, opponent memory, API client
  pages/        Home
  poker/
    core/         card codes, seeded RNG (xoshiro128**), Wilson intervals
    table/        engine, state, No-Limit rules, side pots, positions
    equity/       multiway sampler + Web Worker pool
    model/        ranges, hand-class buckets, likelihoods, learning, the decider
    solver/       Discounted CFR, exploitability, push/fold validation
    replay/       reconstruct and re-simulate a hand from its seed
    coach/        EV-loss attribution and playing-style stats
    handEvaluator.ts   bit-parallel 5–7 card evaluation
    ev.ts              expected value, fold equity, call pricing
  store/        React context wiring the engine to the UI
  workers/      equity shard worker
api/            serverless functions (accounts, saved hands)
```

## Rules & betting

- No-Limit Texas Hold'em, **2–6 seats**; default table is 4 seats at 100 big
  blinds with **$5/$10** blinds.
- Standard No-Limit raise sizing: a raise must increase the bet by at least as
  much as the last raise did, and preflop the big blind counts as the opening
  raise.
- An all-in for **less than a full raise does not reopen the betting** — seats
  that already acted owe the difference but may not re-raise.
- **Side pots** are cut at each distinct all-in level, so a seat all-in for `X`
  can win at most `Σ min(X, invested_j)`. Odd chips go to the first seat left of
  the button.
- Busted seats rebuy, so the table never shrinks mid-session.

Chip conservation and hand termination are checked before **every action**, not
once per hand, across 5 table sizes × 5 scripted styles × 1,000 hands.

## Hand review

Every finished hand opens into four tabs:

- **Hand** — what happened, and what it cost each seat.
- **Ranges** — the 13×13 chart of what the table thought everyone held,
  rebuilt exactly the way the sampler built it, plus the blockers your cards
  removed.
- **Your play** — every decision, re-priced two ways, with the EV loss attributed.
- **Math** — where the numbers on the other tabs come from: the Wilson interval
  and why it isn't `p̂ ± 1.96·SE`, the street-by-street equity ladder and why the
  last rung is a fact rather than an estimate, the made-hand distribution, Bayes'
  rule on the actual likelihood rows used, the EV of every action *and every
  size* considered with the fold-equity derivation behind each one, and what the
  model has learned about you.

The review reads the stored decision records rather than recomputing them, so the
EV numbers on screen are literally the ones the bot decided with. The two things
it *does* recompute — the street equities and the range charts — are recomputed
from the record's own contents, and it says so: if a number cannot be recovered
from what the engine wrote down, the review does not invent it.

---

© 2026 Shardul Marathe. All rights reserved. This source is published for
portfolio review; it is not licensed for reuse, modification, or redistribution.
