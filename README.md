# Probability Poker

> Can probability outperform human intuition?

An educational, probability-focused **heads-up Texas Hold'em** simulator built for
a Stanford probability course. You play against a purely probability-driven bot
that makes every decision with **Bayesian opponent modeling**, **Monte Carlo
simulation**, and **expected value** maximization — then reviews each hand in a
full probability dashboard.

Everything runs client-side. There is no backend, database, or network call.
Refreshing the page resets the match.

## Tech stack

- **React 19** + **TypeScript**
- **Vite** (dev server + build)
- **Tailwind CSS v4**
- **Recharts** (charts)

## Getting started

```bash
npm install
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # typecheck + production build
npm run preview  # preview the production build
npm test         # run the test suite
```

Every hand is dealt from a seed, so a hand replays exactly from its seed alone
and the test suite is fully deterministic. Equity simulation runs in a Web
Worker pool, with an in-process fallback when workers are unavailable.

## The probability concepts on display

| Concept | Where it lives |
| --- | --- |
| **Conditional probability** | Opponent action likelihoods `P(action \| tier)` (`src/data/constants.ts`) |
| **Bayesian reasoning** | Belief updates `P(tier \| action)` (`src/poker/bayesian.ts`) |
| **Monte Carlo simulation** | 5,000 randomized roll-outs (`src/poker/monteCarlo.ts`) |
| **Expected value** | `EV = P(win)·gain + P(loss)·loss + P(tie)·tie` (`src/poker/ev.ts`) |
| **Probability distributions** | Made-hand frequencies + belief evolution (Analysis page) |

## How the bot thinks

1. **Bayesian opponent model** — the bot tracks a belief distribution over the
   player's hand strength (`weak` / `medium` / `strong`). After every player
   action it applies Bayes' rule:
   `posterior(tier) ∝ prior(tier) · P(action | tier)`.
2. **Monte Carlo simulation** — it estimates equity by simulating thousands of
   complete boards. The player's unknown hole cards are sampled from the
   remaining deck, weighted by the current belief distribution.
3. **Expected value** — it computes the EV of every legal action using real pot
   sizes and chooses the highest. The bot never bluffs and uses no randomness
   beyond Monte Carlo sampling.

## Project structure

```
src/
  components/   reusable UI (playing card)
  data/         tunable constants (blinds, priors, likelihoods)
  lib/          formatting helpers
  pages/        Home, Game, Analysis
  poker/        engine, split by responsibility:
    cards.ts          deck + card utilities
    handEvaluator.ts  5–7 card hand evaluation
    bayesian.ts       Bayesian opponent model
    monteCarlo.ts     Monte Carlo simulation
    ev.ts             expected value engine
    betting.ts        legal action rules
    botStrategy.ts    EV-maximizing decision
    gameEngine.ts     heads-up limit Hold'em state machine
  store/        React context wiring the engine to the UI
  types/        shared domain types
scripts/
  profile.ts    engine benchmarks (npx tsx scripts/profile.ts)
```

## Rules & betting

- Heads-up Texas Hold'em, starting bankrolls of **$1,000** each.
- Blinds: small **$5**, big **$10**; the dealer alternates each hand.
- Simplified **fixed-limit** betting: bet **$10** preflop/flop, **$20** turn/river;
  a raise doubles the current bet. Only legal actions are shown.

## Analysis dashboard

After every hand you can open a report containing the hand summary, a win
probability timeline, Monte Carlo results, the bot's EV decision table, the
final hand distribution, the Bayesian belief evolution, and full hand history.
