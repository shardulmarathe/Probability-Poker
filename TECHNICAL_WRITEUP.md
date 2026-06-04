# Probability Poker — Mathematical Documentation

This document describes the probability theory implemented in the Probability Poker codebase. The application is a heads-up (two-player) Limit Texas Hold'em engine in which a human plays against a bot whose every decision is driven by Monte Carlo equity estimation, Bayesian opponent modeling, and expected-value maximization. All logic is pure TypeScript in `src/poker/`, with no external solver; this means every number on screen is reproducible from the code.

Notation: I write $\Pr(\cdot)$ for probability, $\mathbb{E}[\cdot]$ for expectation, and use "hero" for the player whose perspective a calculation takes.

---

## 1. Poker State Representation

### Purpose
Before any probability can be computed, the game must be encoded as data structures that distinguish **known** information (the hero's cards, the board, the betting) from **hidden** information (the opponent's cards, future board cards). The hidden part is exactly what the probability engine must integrate over.

### Deck and card representation
A card is a `{rank, suit, id}` triple, with rank $\in\{2,\dots,14\}$ (14 = Ace) and suit $\in\{s,h,d,c\}$:

```ts
export interface Card {
  rank: RankValue;
  suit: Suit;
  /** Stable id like "As", "Td", "2c". */
  id: string;
}
```

The deck is the full Cartesian product $\{2,\dots,14\}\times\{s,h,d,c\}$, giving $|D| = 13\times 4 = 52$ distinct cards (`src/poker/cards.ts`, `makeDeck`).

Shuffling uses **Fisher–Yates**, which produces a uniform random permutation: iterating $i$ from $n-1$ down to 1 and swapping element $i$ with a uniformly chosen $j\in\{0,\dots,i\}$ yields each of the $n!$ orderings with probability $1/n!$ (`src/poker/cards.ts`, `shuffle`).

The uniformity of this shuffle is the foundation of every probability estimate downstream: it is the assumption that the unseen cards are exchangeable and equally likely in every unseen slot.

### Hole cards and community cards
At the start of a hand the first four shuffled cards are dealt as two hole cards each; the rest form the undealt deck (`src/poker/gameEngine.ts`, `startHand`):

```ts
const deck = shuffle(makeDeck());
state.playerHole = [deck[0], deck[1]];
state.botHole = [deck[2], deck[3]];
state.community = [];
state.deck = deck.slice(4);
```

Community cards are revealed in the standard streets — flop (3 cards), turn (1), river (1) — by splicing off the deck in `advanceStreet`. The number of community cards $c=|\text{community}|$ takes values $0,3,4,5$ across preflop/flop/turn/river, and the number of board cards still to come is $5-c$. This quantity drives the dimension of the Monte Carlo integral in §2.

### Betting state (probability-relevant)
The fields that matter for the decision math are the pot, the per-street commitments, and the current bet level (`src/types/index.ts`, `GameState`):

```ts
pot: number;
/** Chips invested this street. */
streetCommit: Record<Seat, number>;
/** Total chips invested this hand. */
invested: Record<Seat, number>;
/** Current bet level to match this street. */
currentBet: number;
acted: Record<Seat, boolean>;
raisesThisStreet: number;
toAct: Seat | null;
```

The amount a seat must pay to continue is the derived quantity `toCall = currentBet − streetCommit[seat]`, computed in `decideBotAction`. Fixed-limit bet sizes are constants: $\$10$ preflop/flop and $\$20$ turn/river, with at most 4 raises per street, blinds $\$5/\$10$, starting stack $\$1000$ (`src/data/constants.ts`):

```ts
export const STARTING_BANKROLL = 1000;
export const SMALL_BLIND = 5;
export const BIG_BLIND = 10;

export const BET_SIZE: Record<Exclude<Street, "showdown">, number> = {
  preflop: 10,
  flop: 10,
  turn: 20,
  river: 20,
};

export const MAX_RAISES_PER_STREET = 4;
```

### The probability-relevant state, summarized
At any decision point, the engine's epistemic state is the triple

$$
\big(\underbrace{H_{\text{hero}}, B}_{\text{known cards}},\ \underbrace{\beta = (\beta_w,\beta_m,\beta_s)}_{\text{belief over opp. tier}}\big),
$$

where $H_{\text{hero}}$ is the two known hole cards, $B$ the $c$ known board cards, and $\beta$ the Bayesian belief distribution over the opponent's hidden strength tier (§6). The unknown is the opponent's hole pair $H_{\text{opp}}$ plus the $5-c$ unseen board cards. Everything in §2–§8 is a function of this state.

---

## 2. Monte Carlo Simulation Engine

### Purpose and why Monte Carlo is needed
The bot must estimate its probability of winning the hand, $\Pr(\text{win})$. In principle this is a finite combinatorial sum: enumerate every possible assignment of the opponent's two hole cards and the remaining board, evaluate the showdown, and average. But the number of completions is large. Preflop, with 50 unknown cards, the opponent has $\binom{50}{2}=1225$ possible hands, and for each the remaining 5 board cards can be chosen $\binom{48}{5}=1{,}712{,}304$ ways — on the order of $2\times10^{9}$ joint outcomes. Exact enumeration on every click is infeasible, so the engine **estimates** the expectation by random sampling. This is the Monte Carlo method: replace an intractable exact average with the sample mean of i.i.d. draws.

### The hidden-information problem and how it is sampled
The bot does not see the opponent's cards. There are two distinct simulators because there are two distinct epistemic situations:

1. **`runBeliefMonteCarlo`** — used live by the bot. The opponent's hole cards are *unknown*, so they are sampled from a belief-weighted distribution (described below).
2. **`runFullKnowledgeMonteCarlo`** — used in post-hand analysis (timeline, distributions), where both hole hands are known and only future board cards are random.

Both share the structure: identify the unknown slots, fill them with cards drawn without replacement from the remaining pool, score the 7-card hands, tally win/loss/tie.

The "pool" of cards unknown to the bot is the deck minus the bot's hole and the visible board (`src/poker/botStrategy.ts`):

```ts
export function botUnknownPool(state: GameState) {
  return removeCards(makeDeck(), [...state.botHole, ...state.community]);
}
```

#### Sampling the opponent's hole cards (belief-weighted importance sampling)
Rather than drawing the opponent's hand uniformly, the bot samples it from its current belief over strength tiers. First, every possible two-card combo in the pool is bucketed once into weak/medium/strong via `tierOf` (`src/poker/monteCarlo.ts`):

```ts
const byTier: Record<StrengthTier, number[][]> = { weak: [], medium: [], strong: [] };
for (let i = 0; i < L; i++) {
  for (let j = i + 1; j < L; j++) {
    byTier[tierOf(pool[i], pool[j])].push([i, j]);
  }
}
```

Each simulation then (a) draws a tier $T$ according to the belief $\beta$, and (b) draws a hand uniformly within that tier. The tier is chosen by inverse-CDF sampling of the categorical belief:

```ts
function weightedTier(b: BeliefDistribution): StrengthTier {
  const r = Math.random();
  if (r < b.weak) return "weak";
  if (r < b.weak + b.medium) return "medium";
  return "strong";
}
```

Mathematically, the opponent's sampled hand $H_{\text{opp}}$ has the mixture distribution

$$
\Pr(H_{\text{opp}} = h) = \sum_{T\in\{w,m,s\}} \beta_T \cdot \frac{\mathbb{1}[\,\text{tier}(h)=T\,]}{N_T},
\qquad N_T = |\{\text{combos in tier }T\}|.
$$

This is the mechanism by which the **Bayesian belief feeds the equity estimate**: a belief that the opponent is strong over-samples strong holdings, lowering the bot's estimated $\Pr(\text{win})$. It is a form of importance sampling, where the proposal is the belief-weighted hand distribution rather than the uniform one.

#### Sampling the future community cards
The remaining $5-c$ board cards are drawn without replacement from the pool, excluding the two cards already assigned to the opponent. The code does this with a partial Fisher–Yates over an index permutation, after first moving the opponent's two indices to the tail so they cannot be redrawn. The drawn board cards are shared (`botHand` and `oppHand` both receive `card`), correctly modeling that the community is common to both players.

### The estimators (derivation)
Let $N$ be the number of simulations. In simulation $s$, let $X_s=1$ if the bot's best 5-card hand beats the opponent's, $Y_s=1$ for a loss, $Z_s=1$ for a tie (exactly one is 1). The comparison uses the integer `score` from the hand evaluator (§4):

```ts
const botEval = fixedBot ?? evaluate(botHand);
const oppEval = evaluate(oppHand);
freq[botEval.category] += 1;
if (botEval.score > oppEval.score) win++;
else if (botEval.score < oppEval.score) loss++;
else tie++;
```

The Monte Carlo estimators are the sample means, which is exactly what `finalize` returns:

$$
\widehat{\Pr}(\text{win}) = \frac{1}{N}\sum_{s=1}^N X_s = \frac{\text{Wins}}{N},\quad
\widehat{\Pr}(\text{loss}) = \frac{\text{Losses}}{N},\quad
\widehat{\Pr}(\text{tie}) = \frac{\text{Ties}}{N}.
$$

```ts
return {
  simulations: sims,
  pWin: win / sims,
  pLoss: loss / sims,
  pTie: tie / sims,
  categoryFrequencies: probFreq,
};
```

**Unbiasedness and error.** Because each $X_s$ is an i.i.d. Bernoulli$(p)$ draw with $p=\Pr(\text{win})$, we have $\mathbb{E}[\widehat p] = p$ (unbiased) and variance $\operatorname{Var}(\widehat p)=p(1-p)/N$. The standard error is therefore

$$
\mathrm{SE}(\widehat p)=\sqrt{\frac{p(1-p)}{N}} \le \frac{1}{2\sqrt N}.
$$

The Analysis UI surfaces exactly this bound, reporting accuracy of $\pm 100/\sqrt{N}$ percentage points (`MonteCarloExplain`). For $N=5000$ this is $\approx\pm 1.4\%$.

### Number of simulations per street, and why they differ
Live decisions use street-dependent counts; post-hand analysis uses larger fixed counts (`src/data/constants.ts`):

```ts
export const MONTE_CARLO_SIMS = 5000;

export const DECISION_SIMS: Record<Exclude<Street, "showdown">, number> = {
  preflop: 7000,
  flop: 7000,
  turn: 5000,
  river: 3000,
};

export const TIMELINE_SIMS = 1500;
```

The counts **decrease** from preflop (7000) to river (3000) because the variance of the per-sim outcome shrinks as information accrues: on the river there are zero unknown board cards, so only the opponent's hand is random and far fewer samples achieve the same standard error. Early streets have higher-dimensional randomness (more unknown board cards → larger effective outcome variance) and so get more samples. The choice is a deliberate trade between estimator error $O(1/\sqrt N)$ and the latency budget (<500 ms/decision).

### Performance optimizations
These do not change the mathematics, only the constant factor:
- **Tier bucketing once per decision:** $O(L^2)$ combos are classified a single time, then each sim is an $O(1)$ lookup.
- **Pre-allocated 7-card buffers** reused across sims, avoiding per-sim allocation.
- **Memoized hand evaluation** keyed by a 52-bit card-set bitmask (`handEvaluator.ts`); on a complete board the bot's own hand is evaluated once (`fixedBot`).

### Pseudocode matching the implementation
```
function runBeliefMonteCarlo(botHole, board, pool, belief β, N):
    bucket every pair (i,j) in pool into byTier[tierOf(i,j)]
    needed ← 5 − |board|
    win ← loss ← tie ← 0
    freq[category] ← 0 for all categories
    for s in 1..N:
        T ← weightedTier(β)                      # inverse-CDF on (βw, βm, βs)
        (a,b) ← uniform random pair from byTier[T]
        oppHole ← (pool[a], pool[b])
        draw `needed` board cards from pool excluding {a,b}   # partial Fisher–Yates
        botBest ← evaluate(botHole ∪ board ∪ drawn)
        oppBest ← evaluate(oppHole ∪ board ∪ drawn)
        freq[botBest.category] += 1
        if botBest.score > oppBest.score: win += 1
        elif botBest.score < oppBest.score: loss += 1
        else: tie += 1
    return { pWin: win/N, pLoss: loss/N, pTie: tie/N,
             categoryFrequencies: freq/N }
```

---

## 3. Probability Timeline

### Purpose
The timeline visualizes how the hand's outcome was *actually* decided over time, in hindsight. It plots the hero's win probability at each street that was reached.

### What "equity" means
Equity is a player's share of the pot under random completion of the unknown cards — operationally, the probability of winning at showdown (with ties split). In the timeline this is computed under **full knowledge** of both hole hands, so the only randomness is the undealt board. This is *not* the bot's in-hand belief estimate; it is the true conditional win probability given everything except the future board:

$$
\text{equity}_{\text{street}} = \Pr\big(\text{hero wins} \mid H_{\text{hero}}, H_{\text{opp}}, B_{\text{street}}\big),
$$

estimated by Monte Carlo over the $5-c$ remaining cards.

### How each point is generated
`generateAnalysis` runs `runFullKnowledgeMonteCarlo` once per reached street, each with $N=$`TIMELINE_SIMS`$=1500$ random board completions (`src/poker/gameEngine.ts`):

```ts
const streets: [TimelinePoint["street"], number][] = [
  ["Preflop", 0], ["Flop", 3], ["Turn", 4], ["River", 5],
];
for (const [label, n] of streets) {
  if (community.length < n) break;
  const board = community.slice(0, n);
  const pool = removeCards(makeDeck(), [...playerHole, ...botHole, ...board]);
  const mc = runFullKnowledgeMonteCarlo(playerHole, botHole, board, pool, TIMELINE_SIMS);
  timeline.push({ street: label, playerWin: mc.pWin, botWin: mc.pLoss, tie: mc.pTie });
}
```

Note the slice `community.slice(0, n)`: the equity at the flop uses only the first 3 board cards even though all 5 are known post-hand, faithfully reconstructing the information available *at that street*. The chart maps `playerWin → Player line`, `botWin → Bot line`.

When the board is complete ($n=5$, `needed===0`), `runFullKnowledgeMonteCarlo` short-circuits to a deterministic evaluation — equity is exactly 0% or 100% (or a tie), with no sampling.

### Why probabilities change between streets
Each revealed board card is **information** that conditions the probability. Formally, by the tower property, equity is a martingale in the information filtration $\mathcal{F}_{\text{preflop}}\subseteq\mathcal{F}_{\text{flop}}\subseteq\dots$:

$$
\mathbb{E}\big[\text{equity}_{\text{river}} \mid \mathcal{F}_{\text{flop}}\big] = \text{equity}_{\text{flop}},
$$

i.e. the next street's equity is an unbiased refinement of the current one, but its realized value jumps as the conditioning set grows. The variance of equity decreases to zero by the river, where $\mathcal{F}_{\text{river}}$ determines the winner exactly. This is precisely why the lines fan out toward 0%/100% as the hand progresses.

---

## 4. Hand Distribution Analysis

### Purpose
Beyond win/loss, the engine reports the full distribution over the hero's *final made-hand category* (pair, flush, etc.). Two hands can share the same win probability but make their hands very differently; the distribution captures that shape.

### Estimator (derivation)
During the same Monte Carlo loop, every roll-out increments a histogram bucket for the hero's best-hand category (`freq[botEval.category] += 1`). `finalize` then normalizes:

$$
\widehat{\Pr}(\text{category}=k) = \frac{\text{count}(k)}{N},\qquad k\in\{\text{HighCard},\dots,\text{StraightFlush}\}.
$$

The representative distribution shown on the Analysis page is the preflop full-knowledge run with $N=$`MONTE_CARLO_SIMS`$=5000$. Because the nine categories are mutually exclusive and exhaustive, $\sum_k \widehat{\Pr}(k)=1$.

### How categories are determined
The histogram is only as meaningful as the hand evaluator that labels each roll-out. `evaluate` classifies any 5–7 card set into one of nine categories and assigns a totally-ordered integer `score` so ties and wins can be compared with a single `>`:

```ts
const BASE = 15;
function encode(category: HandCategory, kickers: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) {
    score = score * BASE + (kickers[i] ?? 0);
  }
  return score;
}
```

This computes $\text{score} = \text{category}\cdot 15^5 + \sum_{i=0}^{4} k_i\,15^{4-i}$, a base-15 positional encoding. Since each kicker rank is $\le 14 < 15$, the category dominates and kickers break ties lexicographically — a correct total order on poker hands. The categories are detected by counting ranks and suits (`classify`):

- **Pair** — exactly one rank with count 2.
- **Two Pair** — two distinct ranks of count 2.
- **Trips (Three of a Kind)** — a rank of count 3, no pair to upgrade it.
- **Straight** — five consecutive ranks, detected by sliding a 5-bit window over a rank bitmask, with the Ace duplicated as low to handle the wheel A-2-3-4-5 (`straightHigh`).
- **Flush** — a suit with $\ge 5$ cards.
- **Full House** — trips plus a pair, or two sets of trips.
- **Quads (Four of a Kind)** — a rank of count 4.
- **Straight Flush** — a straight within the flushed suit's rank mask.

The detection order (straight flush → quads → full house → flush → straight → trips → two pair → pair → high card) mirrors the rank ordering of `HandCategory` so the first match is always the best category.

---

## 5. Expected Value Calculations

### Purpose and why EV dominates win probability
Win probability alone is insufficient for a betting decision: a 30%-equity call can be correct if the pot is large relative to the cost, and an 80%-equity call can be unprofitable if the price is wrong. The bot therefore chooses by **expected value** — the average chip outcome of an action — not by equity. This converts probabilities into decisions.

### Definition
For a discrete chip outcome $O$,

$$
\mathbb{E}[O] = \sum_i o_i\,\Pr(o_i).
$$

The engine uses a **forward-looking** (pot-odds) model measured from the decision point: chips already in the pot are sunk and ignored; only chips risked *now* and the pot that can be won enter the calculation. This is what makes folding ever correct.

### Derivation of each action's EV
All EVs come from one function (`src/poker/ev.ts`):

```ts
export function actionEv(action, mc, pot, toCall): number {
  if (action.type === "fold") return 0;
  const extra = Math.max(0, action.cost - toCall);
  return mc.pWin * (pot + extra) - mc.pLoss * action.cost;
}
```

Let $p=\Pr(\text{win})$, $q=\Pr(\text{loss})$, pot $=P$, the action's immediate chip cost `cost`, and the amount owed `toCall`. Define $\text{extra} = \max(0,\ \text{cost}-\text{toCall})$. The general formula implemented is

$$
\mathbb{E}[\text{action}] = p\,(P + \text{extra}) - q\cdot\text{cost}.
$$

Ties contribute $\approx 0$ (chip-neutral, the player gets their own chips back). Specializing:

- **EV(Fold)** $= 0$. The baseline: risk nothing, win nothing. An action is only chosen over folding if its EV exceeds 0.

- **EV(Check):** a check has `cost = 0` and `toCall = 0`, so $\text{extra}=0$:

$$
\mathbb{E}[\text{Check}] = p\cdot P.
$$

You risk no chips but can still win the existing pot at showdown.

- **EV(Call):** a call has `cost = toCall`, so $\text{extra}=0$:

$$
\mathbb{E}[\text{Call}] = p\cdot P - q\cdot\text{toCall}.
$$

You win the pot $P$ with probability $p$ and lose your called chips with probability $q$. Setting $\mathbb{E}[\text{Call}]>0$ recovers the classic pot-odds rule $p/q > \text{toCall}/P$.

- **EV(Bet):** opening a bet with no prior bet means `toCall = 0` and `cost = betSize`, so $\text{extra} = \text{cost}$. Assuming the opponent matches the bet, the winnable pot grows by that extra:

$$
\mathbb{E}[\text{Bet}] = p\,(P + \text{cost}) - q\cdot\text{cost}.
$$

- **EV(Raise):** facing a bet, `cost = newLevel − committed` (the raise total) and $\text{extra} = \text{cost} - \text{toCall} > 0$ is the additional amount beyond a call:

$$
\mathbb{E}[\text{Raise}] = p\,(P + \text{extra}) - q\cdot\text{cost}.
$$

The legal `cost`/`amount` values for each action are produced by `getLegalActions` (`src/poker/betting.ts`), e.g. a raise sets the new level to `currentBet * 2` clamped to the stack.

### How the bot chooses: argmax(EV)
`decideBotAction` runs one Monte Carlo estimate, computes the pot and `toCall`, then iterates over the legal actions tracking the maximizer — a direct implementation of $\arg\max$ (`src/poker/botStrategy.ts`):

```ts
let best: LegalAction = legal[0];
let bestEv = -Infinity;
for (const action of legal) {
  const ev = actionEv(action, mc, pot, toCall);
  evByType.set(action.type, ev);
  if (ev > bestEv) { bestEv = ev; best = action; }
}
```

Formally the bot plays

$$
a^\star = \arg\max_{a\in\mathcal{A}(\text{state})} \mathbb{E}[a],
$$

where $\mathcal{A}$ is the legal action set. Each candidate EV is stored for the explanation layer (§8). Because $p$ and $q$ come from the **belief-weighted** Monte Carlo, the opponent model (§6–§7) flows directly into the EV and hence into the chosen action.

---

## 6. Bayesian Belief Evolution

### Purpose
The bot cannot see the opponent's cards, so it maintains a probability distribution over how strong they are and revises it after every action the opponent (the human player) takes, using Bayes' theorem. This belief is what re-weights the Monte Carlo hand sampling in §2.

### The three hypotheses (hand-strength tiers)
The hidden state is discretized into three tiers, $H\in\{\text{weak},\text{medium},\text{strong}\}$ (`src/types/index.ts`). A concrete hole pair is mapped to a tier by a Chen-style preflop score and thresholds (`src/poker/bayesian.ts`):

```ts
export function tierOf(a: Card, b: Card): StrengthTier {
  const score = holeScore(a, b);
  if (score >= 9) return "strong";
  if (score >= 5) return "medium";
  return "weak";
}
```

So *strong* $\Leftrightarrow$ Chen score $\ge 9$ (e.g. big pairs, AK), *medium* $\Leftrightarrow 5\le$ score $<9$, *weak* otherwise. This same `tierOf` is used both to bucket sampled opponent hands (§2) and to classify revealed hands for learning (§7), keeping the model internally consistent.

### Prior, likelihood, evidence, posterior
- **Prior** $\Pr(H)$: the belief before the current action. At the start of a hand it is the fixed preflop prior (`src/data/constants.ts`):

```ts
export const INITIAL_BELIEF: BeliefDistribution = {
  weak: 0.4,
  medium: 0.35,
  strong: 0.25,
};
```

- **Likelihood** $\Pr(A\mid H)$: the probability the opponent takes action $A$ given they hold tier $H$. The default (pre-learning) table:

```ts
export const ACTION_LIKELIHOODS: Record<PlayerActionType, BeliefDistribution> = {
  check: { weak: 0.5, medium: 0.35, strong: 0.15 },
  call: { weak: 0.25, medium: 0.5, strong: 0.25 },
  bet: { weak: 0.15, medium: 0.35, strong: 0.5 },
  raise: { weak: 0.05, medium: 0.25, strong: 0.7 },
  fold: { weak: 0.8, medium: 0.15, strong: 0.05 },
};
```

These encode behavioral assumptions: a raise is far more likely from a strong hand (0.70) than a weak one (0.05); a check is most likely from a weak hand (0.50).

- **Evidence** $\Pr(A)$: the normalizing constant $\sum_H \Pr(A\mid H)\Pr(H)$.
- **Posterior** $\Pr(H\mid A)$: the revised belief.

### Bayes' rule (derivation)
By the definition of conditional probability, $\Pr(H\mid A)=\Pr(H,A)/\Pr(A)$ and $\Pr(H,A)=\Pr(A\mid H)\Pr(H)$. Combining,

$$
\Pr(H\mid A) = \frac{\Pr(A\mid H)\,\Pr(H)}{\Pr(A)} = \frac{\Pr(A\mid H)\,\Pr(H)}{\sum_{H'} \Pr(A\mid H')\,\Pr(H')}.
$$

The denominator is the law of total probability over the three tiers. The implementation computes the unnormalized numerators and divides by their sum (`src/poker/bayesian.ts`):

```ts
export function updateBelief(prior, action, likelihoods = ACTION_LIKELIHOODS): BeliefDistribution {
  const like = likelihoods[action];
  return normalize({
    weak: prior.weak * like.weak,
    medium: prior.medium * like.medium,
    strong: prior.strong * like.strong,
  });
}
```

`normalize` divides by the evidence $\Pr(A)$; the degenerate guard (all-zero) returns the uniform distribution. Each update is recorded as a `BeliefSnapshot` storing `before`, `after`, and the exact `likelihood` row used, so the belief is a sequence of posteriors, each serving as the prior for the next action.

### How each action moves beliefs
Multiplying the prior by the likelihood column and renormalizing shifts mass toward the tiers most consistent with the action:
- **Raise** (0.05 / 0.25 / 0.70) sharply concentrates belief on *strong*.
- **Bet** (0.15 / 0.35 / 0.50) tilts toward *strong/medium*.
- **Call** (0.25 / 0.50 / 0.25) concentrates on *medium*.
- **Check** (0.50 / 0.35 / 0.15) tilts toward *weak*.
- **Fold** (0.80 / 0.15 / 0.05) tilts toward *weak* (though a fold ends the hand).

### Complete numerical example (default likelihoods)
Start from the prior $\Pr(H)=(0.40,\,0.35,\,0.25)$ for (weak, medium, strong). The player **raises**; the likelihood row is $\Pr(\text{raise}\mid H)=(0.05,\,0.25,\,0.70)$.

Unnormalized numerators $\Pr(\text{raise}\mid H)\Pr(H)$:

$$
\begin{aligned}
\text{weak} &: 0.05\times0.40 = 0.0200,\\
\text{medium} &: 0.25\times0.35 = 0.0875,\\
\text{strong} &: 0.70\times0.25 = 0.1750.
\end{aligned}
$$

Evidence (normalizer):

$$
\Pr(\text{raise}) = 0.0200 + 0.0875 + 0.1750 = 0.2825.
$$

Posterior:

$$
\Pr(H\mid\text{raise}) = \left(\frac{0.0200}{0.2825},\ \frac{0.0875}{0.2825},\ \frac{0.1750}{0.2825}\right) \approx (0.0708,\ 0.3097,\ 0.6195).
$$

So a single raise moves the bot's belief that the opponent is strong from 25% to $\approx 62\%$, while weak collapses from 40% to $\approx 7\%$. This posterior is exactly the worked example rendered in `BayesWorked`, which reads the stored `snapshot.likelihood` so the displayed arithmetic matches whatever table (default or learned) was actually applied.

---

## 7. Learned Opponent Model

### Purpose
The default likelihood table is a fixed, generic assumption. The learned opponent model replaces it with **empirically estimated** likelihoods that adapt to how the specific human plays, so that, e.g., a habitual bluffer's raises are correctly discounted. This is the core upgrade that turns a static Bayesian filter into an adaptive one.

### What is stored
For each tier the model keeps per-action tallies that persist for the whole session (`src/types/index.ts`):

```ts
export interface TierActionStats {
  total: number;   // hands of this tier observed at showdown
  raises: number;  // ... in which the player raised at least once
  calls: number;
  checks: number;
  folds: number;
  bets: number;
}
export interface OpponentModel { weak; medium; strong: TierActionStats }
```

This lives on `GameState.opponentModel`. Critically, `startHand` resets the per-hand belief but **not** the model, so learning accumulates across hands; only a brand-new game (`createInitialGame`) zeroes it.

### How showdown information is incorporated
Learning only happens when the opponent's cards become known — at **showdown** (folded hands reveal nothing). `resolveShowdown` classifies the player's revealed hole cards into their *true* tier via `tierOf`, gathers the actions they took this hand from the belief-evolution log, and records them (`src/poker/gameEngine.ts`):

```ts
function learnFromShowdown(state: GameState): void {
  if (state.playerHole.length < 2) return;
  const tier = tierOf(state.playerHole[0], state.playerHole[1]);
  const actions = state.beliefEvolution
    .filter((b) => b.triggerAction !== null)
    .map((b) => b.triggerAction as PlayerActionType);
  recordShowdownHand(state.opponentModel, tier, actions);
}
```

```ts
export function recordShowdownHand(model, tier, actions): void {
  const stats = model[tier];
  stats.total += 1;
  for (const action of new Set(actions)) {
    stats[ACTION_STAT_KEY[action]] += 1;
  }
}
```

The `new Set(actions)` makes each action a **per-hand indicator**: a tier's `raises` counts the number of revealed hands of that tier in which the player raised *at least once*, and `total` counts hands of that tier. Thus each $\Pr(\text{action}\mid\text{tier})$ is an independent per-hand event probability (they need not sum to 1 across actions).

### How frequencies become likelihoods (Beta-prior smoothing)
Raw frequencies are unstable when `total` is small (one hand would swing an estimate to 0 or 1). The model therefore uses **Laplace/Beta-prior smoothing**:

$$
\Pr(\text{action}\mid \text{tier}) = \frac{\text{handsWithAction} + \alpha}{\text{handsObserved} + \delta},
\qquad \alpha = 2,\ \delta = 10.
$$

```ts
export const LEARNING_PRIOR_ALPHA = 2;
export const LEARNING_PRIOR_DENOM = 10;

export function learnedLikelihood(stats, action): number {
  const count = stats[ACTION_STAT_KEY[action]];
  return (count + LEARNING_PRIOR_ALPHA) / (stats.total + LEARNING_PRIOR_DENOM);
}
```

**Interpretation as a Beta posterior mean.** Treat "did the player take this action in a hand of this tier?" as a Bernoulli with rate $\theta$. Place a $\text{Beta}(\alpha,\ \delta-\alpha)=\text{Beta}(2,8)$ prior on $\theta$. After observing $n=$`total` hands with $k=$`count` successes, the posterior is $\text{Beta}(k+2,\ n-k+8)$, whose mean is

$$
\mathbb{E}[\theta\mid \text{data}] = \frac{k+2}{n+10},
$$

exactly the implemented formula. With no data ($n=k=0$) every action starts at $2/10 = 0.20$ — a deliberate, neutral $\approx20\%$ prior. As $n\to\infty$ the estimate converges to the empirical frequency $k/n$, so the prior's influence vanishes with evidence. This is a textbook conjugate Beta–Bernoulli update.

The full learned table is assembled per action across tiers and handed to the Bayesian update via `learnedActionLikelihoods(model)`.

### How future Bayesian updates use the learned data
Every in-hand belief update pulls the likelihoods from the learned model instead of the constant table (`src/poker/gameEngine.ts`):

```ts
if (state.status === "playing" || action.type === "fold") {
  const likelihoods = learnedActionLikelihoods(state.opponentModel);
  const before = { ...state.belief };
  const after = updateBelief(before, action.type, likelihoods);
  state.belief = after;
  state.beliefEvolution.push({
    street: state.street,
    triggerAction: action.type,
    before, after,
    likelihood: { ...likelihoods[action.type] },
  });
}
```

### Why this is an adaptive probability model — equations
Let $n_T$ be hands observed in tier $T$ and $k_{a,T}$ the count of those with action $a$. The likelihood used at hand $t+1$ is

$$
\Pr^{(t+1)}(a\mid T) = \frac{k_{a,T}^{(t)} + 2}{n_T^{(t)} + 10},
$$

and the belief update for an observed action $a$ is

$$
\Pr(T\mid a) = \frac{\Pr^{(t+1)}(a\mid T)\,\Pr(T)}{\sum_{T'}\Pr^{(t+1)}(a\mid T')\,\Pr(T')}.
$$

Because $\Pr^{(t+1)}$ is itself a function of all prior showdowns, the system is a two-timescale Bayesian filter: a fast per-action belief update *within* a hand, and a slow likelihood update *across* hands. **Worked adaptation example** (verified by running the model in code): after the model observes 15 weak-tier showdowns in which the player raised, $\Pr(\text{raise}\mid\text{weak}) = (15+2)/(15+10) = 17/25 = 0.68$, up from the 0.20 prior. Feeding that into Bayes' rule, a single observed raise now yields posterior $\Pr(\text{weak}\mid\text{raise})\approx 0.64$, versus $\approx 0.07$ under the default table — the bot has learned that *this* player raises light, and reinterprets the same action accordingly. The learned table and per-tier "hands observed" counts are displayed in the "Learned Opponent Model" section of the Analysis page.

---

## 8. "Why Did The Bot Do This?" Section

### Purpose
This section makes the bot's reasoning fully auditable: for every decision it shows the inputs (equity, pot, price), the EV of each candidate action, and the chosen action — so a reviewer can verify the $\arg\max$ by hand.

### How explanations are generated and stored
Every time the bot acts, `decideBotAction` packages the complete decision context into a `BotDecision` record (`src/poker/botStrategy.ts`):

```ts
const decision: BotDecision = {
  street: state.street,
  toCall,
  potBefore: pot,
  monteCarlo: mc,
  ev,
  chosen: best.type,
  belief: { ...state.belief },
};
```

These records are accumulated on `state.decisions` and copied into the immutable `HandReport` at hand end (`buildReport`). The Analysis page reads them back with no recomputation — the displayed numbers are literally the ones used to decide.

### What is displayed and why
`DecisionCard` shows, per decision:
- **P(win)** — `mc.pWin`, the equity that scales every reward term.
- **pot** (`potBefore`) and **to call** (`toCall`) — the reward and the risk in the EV formulas.
- **EV(Fold/Check/Call/Bet/Raise)** — each candidate's value, with the chosen one highlighted; this exposes the $\arg\max$ comparison directly.
- **belief** snapshot — the tier distribution that weighted the Monte Carlo sampling.

The `EvTable` shows the same data across all decisions in the hand. Each value exists because it is a term in §5's EV equation; together they let the reader reconstruct the decision exactly.

### Tracing one complete decision
Consider the bot facing a $\$10$ bet on the flop with pot $P=\$30$, holding a flush draw, with current belief $\beta=(0.4,0.35,0.25)$.

1. **Input state** → `decideBotAction` reads `pot = 30`, `toCall = currentBet − streetCommit.bot = 10`, and the legal actions {fold, call, raise} from `getLegalActions`.
2. **Monte Carlo** → with `street = "flop"`, `sims = DECISION_SIMS.flop = 7000`. `runBeliefMonteCarlo` samples 7000 opponent hands from $\beta$ (over-weighting whatever tiers $\beta$ favors) and completes the 2 remaining board cards, returning say $\widehat p = 0.35$, $\widehat q = 0.62$, $\widehat{\text{tie}}=0.03$.
3. **Bayesian update** → this is applied to the *opponent's* prior action, not the bot's; the belief $\beta$ that weighted step 2 is whatever the player's earlier actions produced via `updateBelief` (§6), using learned likelihoods (§7). The belief is stored on the decision for transparency.
4. **EV calculation** via `actionEv`:
   - $\mathbb{E}[\text{Fold}] = 0$.
   - $\mathbb{E}[\text{Call}] = p\,P - q\cdot\text{toCall} = 0.35\times30 - 0.62\times10 = 10.5 - 6.2 = +\$4.3$.
   - $\mathbb{E}[\text{Raise}]$ with raise total `cost = newLevel − committed`; for a flop raise to $\$20$, $\text{cost}=20,\ \text{extra}=20-10=10$: $0.35\,(30+10) - 0.62\times20 = 14 - 12.4 = +\$1.6$.
5. **Chosen action** → $\arg\max\{0,\ 4.3,\ 1.6\} = \text{Call}$. The loop in `botStrategy.ts` sets `best = call`, `chosen: "call"`, and the card renders Call highlighted with $+\$4.3$ as the maximal EV.

Every number above is stored on the `BotDecision` and re-displayed without re-derivation, which is what makes the section a faithful audit rather than a reconstruction.

---

## 9. Probability Concepts Demonstrated

### Conditional Probability
Definition: $\Pr(A\mid B)=\Pr(A\cap B)/\Pr(B)$, for $\Pr(B)>0$.
Appears: the entire likelihood table is a set of conditionals $\Pr(\text{action}\mid\text{tier})$ (`ACTION_LIKELIHOODS`, `learnedLikelihood`); the timeline equity is the conditional $\Pr(\text{win}\mid H_{\text{hero}},H_{\text{opp}},B)$ (§3); the hand distribution is $\Pr(\text{category}\mid H_{\text{hero}})$ (§4).

### Bayesian Inference
Definition: posterior $\propto$ likelihood $\times$ prior, $\Pr(H\mid A)=\frac{\Pr(A\mid H)\Pr(H)}{\sum_{H'}\Pr(A\mid H')\Pr(H')}$.
Appears: `updateBelief` (§6) is a literal implementation; the cross-hand learning (§7) is a conjugate **Beta–Bernoulli** update whose posterior mean $(k+\alpha)/(n+\delta)$ supplies the likelihoods. The belief sequence is a discrete Bayes filter over the latent tier.

### Monte Carlo Methods
Definition: estimate $\mathbb{E}[f(X)] \approx \frac1N\sum_{s=1}^N f(X_s)$ with $X_s$ i.i.d.; error $O(1/\sqrt N)$.
Appears: `runBeliefMonteCarlo` and `runFullKnowledgeMonteCarlo` estimate win/loss/tie and category frequencies by sampling unknown cards (§2). The belief-weighted variant is **importance sampling** with the belief distribution as proposal. Sim counts (`DECISION_SIMS`, `MONTE_CARLO_SIMS`, `TIMELINE_SIMS`) trade variance for latency.

### Expected Value
Definition: $\mathbb{E}[O]=\sum_i o_i\Pr(o_i)$.
Appears: `actionEv` (§5) computes $p(P+\text{extra}) - q\,\text{cost}$ for each action; the bot plays $\arg\max_a \mathbb{E}[a]$ (`botStrategy.ts`). Folding's EV of 0 is the decision baseline.

### Probability Distributions
Definition: a normalized assignment of probabilities to a sample space; here categorical distributions.
Appears: the belief $\beta$ is a categorical over 3 tiers (normalized in `normalize`); `categoryFrequencies` is a categorical over the 9 hand categories summing to 1 (§4); the opponent-hand sampler draws from a mixture of within-tier uniforms (§2).

### Learning from Data
Definition: updating parameter estimates as observations accrue, with prior-to-data interpolation.
Appears: `recordShowdownHand` accumulates sufficient statistics $(n_T, k_{a,T})$ from revealed hands; `learnedLikelihood` turns them into smoothed estimates that converge to empirical frequencies as $n_T\to\infty$ (§7). The persistence of `opponentModel` across hands is what makes it learning rather than a per-hand reset.

### Decision Making Under Uncertainty
Definition: choosing the action maximizing expected utility given a probability model of unknowns, $a^\star=\arg\max_a \mathbb{E}[U(a)]$.
Appears: the full pipeline — belief over hidden tiers → belief-weighted equity → EV per action → $\arg\max$ (§5, §8). The bot never observes the opponent's cards yet acts optimally with respect to its current probabilistic model, and that model itself improves as uncertainty about the opponent is reduced through showdown observations.

---

## Summary of key constants (single reference)

| Quantity | Symbol | Value | Source |
|---|---|---|---|
| Deck size | $\|D\|$ | 52 | `cards.ts` |
| Decision sims | $N$ | 7000 / 7000 / 5000 / 3000 | `DECISION_SIMS` |
| Report sims | $N$ | 5000 | `MONTE_CARLO_SIMS` |
| Timeline sims | $N$ | 1500 | `TIMELINE_SIMS` |
| Preflop prior | $\Pr(H)$ | (0.40, 0.35, 0.25) | `INITIAL_BELIEF` |
| Tier cutoffs | — | strong $\ge9$, medium $\ge5$ | `tierOf` |
| Default raise likelihood | $\Pr(\text{raise}\mid H)$ | (0.05, 0.25, 0.70) | `ACTION_LIKELIHOODS` |
| Beta-prior | $(\alpha,\delta)$ | (2, 10) → 0.20 each | `LEARNING_PRIOR_*` |
| EV(action) | — | $p(P+\text{extra})-q\,\text{cost}$ | `actionEv` |

Every figure in this document is computed by the code at the cited locations; none are hardcoded outcomes.
