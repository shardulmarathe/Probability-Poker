# Probability Poker — Mathematical Documentation

This document describes the probability theory implemented in the Probability Poker codebase. The application is a **2-to-6-seat No-Limit Texas Hold'em** engine in which a human plays against bots whose every decision is driven by multiway Monte Carlo equity estimation, a Bayesian range model over all 1326 hole-card combinations, and expected-value maximization with fold equity. A separate module solves small games to Nash equilibrium with Discounted CFR and checks the solver against published answers. All logic is pure TypeScript in `src/poker/`, with no external solver; every number on screen is reproducible from the code and from one seed.

The project began as a heads-up fixed-limit match against a single bot, with a three-tier Bayesian belief and a flat likelihood table. Several pieces of that mathematics survive unchanged and are marked where they appear — the Bayes update, the Beta posterior mean, the Wilson interval, the forward-looking EV formula. Several others were superseded, and where they were, the old derivation is usually still the clearest way in: the three-tier belief is exhibited as a coarse range (§3), and the Beta smoothing as one node of a hierarchy (§7). Nothing is annotated as merely out of date; either it is still true and says so, or it is presented as the special case it turned out to be.

Notation: I write $\Pr(\cdot)$ for probability, $\mathbb{E}[\cdot]$ for expectation, and use "hero" for the seat whose perspective a calculation takes.

---

## 1. State, Betting, and the Sample Space

### Purpose
Before any probability can be computed, the game must be encoded as data structures that distinguish **known** information (the hero's cards, the board, the public betting record) from **hidden** information (every other seat's cards, future board cards). The hidden part is exactly what the probability engine must integrate over.

### Deck and card representation
A card is a `{rank, suit, id}` triple, with rank $\in\{2,\dots,14\}$ (14 = Ace) and suit $\in\{s,h,d,c\}$ (`src/poker/cards.ts`). The deck is the full Cartesian product, giving $|D| = 13\times 4 = 52$ distinct cards.

Everything on a hot path speaks a compact integer instead. `src/poker/core/card.ts` encodes a card as $4(\text{rank}-2) + \text{suit} \in \{0,\dots,51\}$, which makes rank and suit a shift and a mask (`c >> 2`, `c & 3`) and lets the evaluator, the sampler and the range model share one representation with no conversion.

Shuffling uses **Fisher–Yates**, which produces a uniform random permutation: iterating $i$ from $n-1$ down to 1 and swapping element $i$ with a uniformly chosen $j\in\{0,\dots,i\}$ yields each of the $n!$ orderings with probability $1/n!$ (`src/poker/core/rng.ts`, `Rng.shuffle`). The uniformity of this shuffle is the foundation of every probability estimate downstream: it is the assumption that the unseen cards are exchangeable and equally likely in every unseen slot.

The randomness itself is **seeded and deterministic** (§10). Cards are dealt one at a time starting left of the button, which is the real dealing order and no more expensive than slicing the deck in seat order (`src/poker/table/engine.ts`, `deal`).

### The N-handed state
Heads-up, every quantity could be a `Record<"player" | "bot", …>` and "the other player" was a function call. With three or more seats those assumptions all break, so state is seat-indexed (`src/poker/table/state.ts`):

```ts
export interface TableSeat {
  stack: number;
  hole: Card[];
  status: "active" | "folded" | "allin" | "out";
  /** Chips committed on the current street. */
  streetCommit: number;
  /** Chips committed across the whole hand — drives the side-pot layers. */
  invested: number;
  hasActed: boolean;
  mayRaise: boolean;
}
```

Two commitment counters, not one, and the distinction is load-bearing. `streetCommit` resets each street and defines the price to continue, $\text{toCall} = \min(\text{currentBet} - \text{streetCommit},\ \text{stack})$; `invested` survives the whole hand and is the only input to the side-pot decomposition below.

A betting round is closed when every seat that can still act has both matched the current bet **and** acted since the last aggression:

```ts
export function bettingClosed(state: TableState): boolean {
  return actingSeats(state).every(
    (s) => s.hasActed && s.streetCommit === state.currentBet
  );
}
```

The `hasActed` flag is what distinguishes "checked around" from "has not been asked yet", and it is why the big blind still gets its option after a round of limps: posting the blind left `hasActed` false even though `streetCommit` already equals `currentBet`.

### No-Limit: the min-raise rule and the undersized all-in
Fixed-limit had a closed action set — bet \$10, raise to \$20, done. No-Limit replaces the size with a continuous range, and that is what makes the decision genuinely hard: the bot must now choose *how much*, and the size it picks changes how often opponents fold, so equity alone no longer determines the play.

A raise must increase the bet by at least as much as the last one did. Preflop the big blind counts as the opening raise, which is why `lastRaiseSize` is seeded with it (`src/poker/table/rules.ts`):

$$
\text{minRaiseTotal} = \text{currentBet} + \max(\text{lastRaiseSize},\ \text{bigBlind}).
$$

The one genuinely subtle rule is the **undersized all-in**. A seat may always jam, even for less than a full raise — but such a jam does not reopen the betting. Seats that already acted owe the extra chips, so they must act again, and yet they are not entitled to re-raise. `hasActed` alone cannot express that: clearing it would hand them a raise, leaving it would skip a debt. Hence a second flag (`src/poker/table/state.ts`, `recordAction`):

```ts
const full = increment >= state.lastRaiseSize;
for (const other of state.seats) {
  if (other.id === id || other.status !== "active") continue;
  const hadActed = other.hasActed;
  other.hasActed = false;
  if (full) other.mayRaise = true;
  else if (hadActed) other.mayRaise = false;
}
state.lastAggressor = id;
if (full) state.lastRaiseSize = increment;
```

Note the last line: only a full raise raises the bar for the next one. An undersized all-in leaves the previous raise size standing.

### The sizing ladder
Humans think in pot fractions, so the interface and the bot's candidate set are a ladder of them — $\tfrac13$, $\tfrac12$, $\tfrac34$, pot — plus an all-in, deduped and clamped to what is legal (`sizingLadder`). The pot a sizing is measured against includes the chips the seat must first put in to call, which is why `toCall` appears twice:

$$
\text{cost}(f) = \text{toCall} + f\cdot(\text{pot} + \text{toCall}).
$$

"Betting pot" therefore means matching the call and then raising by the resulting pot, which is the standard convention and the one §6's $\alpha$ arithmetic assumes.

### Side pots as a layer decomposition
Heads-up needs none of this: settlement is $\text{matched} = \min(\text{invested})$, pot $= 2\,\text{matched}$, refund the difference. With three or more seats and unequal stacks, a short stack all-in for less can only win the portion every caller matched.

`src/poker/table/pots.ts` slices the contributions into layers cut at each distinct investment level. Within a layer every seat that reached it pays the same amount, and only the unfolded ones among them can win it. A layer reached by exactly one seat is an uncalled bet and is refunded rather than turned into a pot. The resulting guarantee is the one the engine tests assert directly: a seat all-in for $X$ can win at most

$$
\sum_j \min(X,\ \text{invested}_j).
$$

Split pots divide evenly and any indivisible remainder goes to the earliest seat in `oddChipOrder` — conventionally the first seat left of the button (`src/poker/table/position.ts`). Chips are integers, so dropping the remainder would quietly destroy money.

### Invariants, and how they are checked
Two properties have to hold at every instant, not merely at the end of a hand:

1. **Conservation.** $\sum_i \text{stack}_i + \text{pot}$ is constant except for tracked rebuys (`totalChips`).
2. **Termination.** The number of actions in a hand stays below a bound derived from the seat count and stack depth.

`src/poker/table/engine.test.ts` checks conservation, termination and action legality **before every single action** rather than once per hand, so a mid-hand accounting slip that the payout happens to cancel out cannot go unseen. The main audit is 5 table sizes × 5 scripted styles × 1,000 hands = **25,000 hands**, with several thousand more across the side-pot-cap, ending-coverage and replay tests.

### The probability-relevant state, summarized
At any decision point the engine's epistemic state is

$$
\big(\underbrace{H_{\text{hero}},\ B}_{\text{known cards}},\ \underbrace{\{R_i\}_{i \in \text{opponents}}}_{\text{a range per seat}},\ \underbrace{P,\ \text{toCall},\ \mathcal{A}}_{\text{price and legal moves}}\big),
$$

where $H_{\text{hero}}$ is the two known hole cards, $B$ the $c$ known board cards, and each $R_i$ is a weight over all $\binom{52}{2}=1326$ hole-card combinations (§3). The unknown is every opponent's hole pair plus the $5-c$ unseen board cards.

This replaces the old triple $\beta = (\beta_w,\beta_m,\beta_s)$, a single distribution over three strength tiers for a single opponent. That belief has not been deleted — it is a coarse range, and §3 exhibits the embedding.

---

## 2. Hand Evaluation

### Purpose
Every probability downstream is an average over showdowns, so the evaluator that decides a showdown is the primitive the whole engine rests on. It must impose a **total order** on hands so ties and wins are decided by a single comparison.

### The score encoding
`evaluate` classifies any 5–7 card set into one of nine categories and assigns an integer `score` (`src/poker/handEvaluator.ts`):

```ts
const BASE = 15;
function encode(category: HandCategory, kickers: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * BASE + (kickers[i] ?? 0);
  return score;
}
```

This computes $\text{score} = \text{category}\cdot 15^5 + \sum_{i=0}^{4} k_i\,15^{4-i}$, a base-15 positional encoding. Since each kicker rank is $\le 14 < 15$, the category dominates and kickers break ties lexicographically — a correct total order on poker hands. `categoryOf` recovers the category as the leading base-15 digit, so a caller that needs both pays for one evaluation.

The categories are detected by counting ranks and suits:

- **Pair** — exactly one rank with count 2.
- **Two Pair** — two distinct ranks of count 2.
- **Trips** — a rank of count 3, no pair to upgrade it.
- **Straight** — five consecutive ranks, detected by sliding a 5-bit window over a 13-bit rank mask, with the Ace duplicated as low to handle the wheel A-2-3-4-5.
- **Flush** — a suit with $\ge 5$ cards.
- **Full House** — trips plus a pair, or two sets of trips.
- **Quads** — a rank of count 4.
- **Straight Flush** — a straight within the flushed suit's rank mask.

The detection order (straight flush → quads → full house → flush → straight → trips → two pair → pair → high card) mirrors the rank ordering of `HandCategory`, so the first match is always the best category.

### Why it is fast, and why that is not a mathematical claim
The scoring is bit-parallel: four per-suit 13-bit rank masks indexed into precomputed lookup tables, with no per-call allocation, and the Monte Carlo loops pass integer card codes (`scoreInts`) rather than card objects. Evaluation is deliberately *not* memoized — measurement showed a hash lookup costs more than recomputing, even at a 100% hit rate. None of this changes a probability; it changes how many samples fit in the latency budget, which changes the standard error (§5).

### The made-hand distribution
Beyond win/loss, a run can report the full distribution over the hero's *final* made-hand category. Every roll-out increments a histogram bucket and the counts are normalized:

$$
\widehat{\Pr}(\text{category}=k) = \frac{\text{count}(k)}{N},\qquad k\in\{\text{HighCard},\dots,\text{StraightFlush}\}.
$$

Because the nine categories are mutually exclusive and exhaustive, $\sum_k \widehat{\Pr}(k)=1$. Two hands can share a win rate and be nothing alike: one that gets there by making flushes plays differently from one that gets there by making top pair — same average, different shape, different bets. The win probability is one number off this whole distribution.

The review runs this at 20,000 trials, matching the budget the street-equity panel uses so the two panels' sampling error is the same size, and reports how many distinct runouts the deck actually allowed alongside it: where the deck allows fewer than 20,000, every runout is hit many times and the shape is exact to within rounding (`src/components/report/MathTab.tsx`).

---

## 3. The Opponent Model I: Ranges over 1326 Combinations

### Purpose
The three-tier belief says how *likely* an opponent is to be strong. It cannot say *which* hands those are, and so it cannot know that the ace of hearts sitting in our own hand makes the nut heart flush impossible for him. A range can.

### The representation
An opponent is a `Float64Array(1326)` — one weight per hole-card combination (`src/poker/model/range.ts`):

```ts
/** C(52, 2). The only length a `Range` is ever allowed to have. */
export const COMBO_COUNT = 1326;
export type Range = Float64Array;
```

Weights are unnormalized until someone asks. `uniformRange()` fills with 1 rather than $1/1326$, so a range reads as a **combo count**: a grid cell of a uniform range holds exactly the textbook 6 / 4 / 12 combos for a pair / suited / offsuit hand, and $13\cdot 6 + 78\cdot 4 + 78\cdot 12 = 1326$.

### Combo indexing
For $a < b$ the index is the number of ordered-by-first-card pairs that precede it:

$$
\text{index}(a,b) = 51a - \frac{a(a-1)}{2} + (b - a - 1).
$$

That closed form is never evaluated at call time — it only builds the forward and reverse tables, so both directions cost a load rather than arithmetic.

### Card removal, and why blockers are free
Conditioning on what the hero can see is one operation:

```ts
export function removeCards(range: Range, cards: ArrayLike<number>): Range {
  for (let k = 0; k < cards.length; k++) {
    // ...zero every combo containing cards[k]
  }
}
```

Removing $k$ distinct cards zeroes exactly $\binom{52}{2} - \binom{52-k}{2}$ combos, and what survives *is* the range conditioned on the visible cards. There is no blocker rule anywhere in the model — blockers are a corollary of the representation. `normalizeRange` throws on an all-zero range rather than falling back to uniform, precisely so a card-removal bug cannot silently resurrect an impossible holding.

Whether a blocker actually moves a *number* depends on how the weights were built, and the codebase pins both answers:

- With a **tier-normalised** range (`beliefRange`, below), deleting the nut flush hands its mass straight back to the other strong combos, so $\Pr(\text{opponent is strong})$ never changes and the equity moves by 0.25062 against 0.25059 — a fortieth of one standard error (`src/poker/equity/multiway.test.ts`).
- With a **per-combo** range built by multiplying likelihoods and never renormalising per tier (`decider.opponentRanges`, §7), the same spot moves 0.1417 to 0.1509, about 16 SE (`src/poker/model/decider.test.ts`).

That contrast is the clearest statement of what the migration bought: the ceiling on a three-tier read is not its granularity, it is that renormalising within a tier destroys exactly the information a blocker carries.

### The three-tier belief as a coarse range
The old model is not gone; it is a special case, and the adapter is explicit (`beliefRange` in `src/poker/equity/multiway.ts`). Given a belief $\beta$ and a bucket assignment (§4), each **tier's total weight** is set to $\beta_T$ and split evenly inside it:

$$
R(h) = \frac{\beta_{T(h)}}{\big|\{h' \text{ live} : T(h')=T(h)\}\big|}.
$$

Setting each *combo* to $\beta_{T(h)}$ instead — the obvious and wrong reading — is a real defect with a measurable size. The weak tier holds several times the combos the strong one does, so a $0.40 / 0.35 / 0.25$ read becomes an effective $0.70 / 0.24 / 0.06$: an opponent four times less likely to hold a real hand than the table believes. Card removal is applied first, so blockers thin the tier they actually hit.

### Sampling: the alias method
A decision draws an opponent hand tens of thousands of times from a range that changes only between decisions, so the draw must be $O(1)$. `makeComboSampler` builds a **Vose alias table** in $O(1326)$ and `drawCombo` spends one `rng.next()`, splitting it into a bucket index and a coin flip rather than spending two draws:

```ts
export function drawCombo(sampler: ComboSampler, rng: Rng): number {
  const u = rng.next() * COMBO_COUNT;
  const i = u | 0;
  return u - i < sampler.prob[i] ? i : sampler.alias[i];
}
```

The coin keeps ~22 bits after the bucket takes its share, far finer than any Monte Carlo here can resolve. The construction is careful about one probabilistic detail: a zero-weight combo left over as float dust is given `prob = 0` and aliased away, so an impossible hand can never be drawn.

### The 13×13 projection
For display, combos aggregate into the 169 canonical hand classes of a standard range chart — rows and columns A, K, Q, …, 2; pairs on the diagonal, suited above it, offsuit below. `toGrid` is deliberately **not** normalized, so the projection conserves weight and "the grid sums to the range" stays testable.

---

## 4. The Opponent Model II: Board-Relative Hand Classes

### The defect this section removes
`bayesian.tierOf` scores a holding with a **Chen preflop formula on every street**. On K-7-2-9-4 it still calls 7-2 "weak" — a hand that has flopped two pair and is beating most of the deck. On 5-6-7-8-9 it calls aces "strong" when they are playing the board. Every equity number the bot acted on was built on that classifier, so this is not a small inaccuracy: it puts the made hands in the wrong bin, and everything sampled from those bins inherits the error.

The size of the error is worth stating concretely. On K♠ 7♥ 2♦ 9♣ 4♠ with a tight read $(0.1,\,0.2,\,0.7)$ on the opponent and A♥A♣ in the hero's hand, the two classifiers disagree like this (reproduced from `src/poker/equity/multiway.test.ts`'s fixtures at 200,000 simulations):

| | preflop `tierOf` | board-relative bucket |
|---|---|---|
| $\Pr(\text{opponent holds } 7\text{-}2)$ | 0.0015 | 0.0594 |
| hero's equity with A♥A♣ | 0.8904 | 0.3031 |

A read that says "this opponent is strong" means *strong on this board*, and on this board strong means two pair. Aces are an overpair, and an overpair against a range of two pairs is a 30% hand, not an 89% one. The same fixture run the other way — A♠A♦ on 5♠ 6♥ 7♦ 8♣ 9♠ — moves $\Pr(\text{opponent holds a ten})$ from 0.1752 to 0.8750 and the hero's equity from 0.4123 to 0.0621, because on a board that already plays a straight, "strong" means "holds a ten" and nothing else does.

(The test asserts these as bounds rather than as point values — 7-2 below 0.002 before and above 0.03 after, equity above 0.85 before and below 0.65 after — so that resampling cannot make it fail spuriously. The figures above are what those fixtures actually produce.)

### The nine classes
`src/poker/model/buckets.ts` classifies a combo *against the board*:

| id | class | meaning |
|---|---|---|
| 0 | Air | no pair, no draw; also where "playing the board" lands |
| 1 | WeakDraw | gutshot, two overcards, or a backdoor flush |
| 2 | StrongDraw | flush draw or open-ender, with cards still to come |
| 3 | WeakPair | bottom pair, or a pocket pair under the board's second-highest card |
| 4 | MidPair | second pair, or a pocket pair between the top two board ranks |
| 5 | TopPair | pairs the highest board card |
| 6 | Overpair | pocket pair above every board card |
| 7 | TwoPair | two pair made with **both** hole cards |
| 8 | Monster | trips or better |

Two rules make the classes honest rather than merely categorical:

- **A hand the whole field also holds is not this combo's hand.** Playing the board is Air; trips the board already shows are not a monster; two pair made of a pocket pair plus a paired board is a one-pair hand. A quads board on the turn is a special case the score comparison cannot see (a four-card partial hand never compares equal to a six-card one), so it is checked separately — without it, 7-7-7-7 on the turn reads Monster for all 1326 combos.
- **Draws are worth something only while cards are still to come.** A flush draw on the flop is not nothing; the same missed draw on the river is exactly nothing, and the taxonomy says so because `needed` has hit zero.

A combo that is both made and drawing takes the better reading, so a flush draw with bottom pair is a flush draw and top pair with a flush draw is at least top pair.

One further refinement is measured rather than argued. A five-card hand shows at most two pairs, so on a board already showing two of its own (K-K-J-J-6) our pair only reaches the hand if it outranks the *lower* of them. Testing against the board's **top** pair instead would bury genuinely strong hands: on A-A-K-7-2, 7-3 makes A-A-7-7, real two pair. Over 200 exact-equity river boards, the `boardPairRank` form drops Somers' D against exact equity from 0.721 to 0.627 while the `boardPair2Rank` form raises it to 0.723.

### The ordering is measured, not asserted
The index is load-bearing: downstream code aggregates "belief mass at or above bucket $k$", which only means anything if the index is monotone in strength. So the cut points were placed by measurement. `buckets.test.ts` rolls out every combo on 60 random boards per street against a random hand and asserts the means come out in order. The measured means:

| board | Air | WeakDraw | StrongDraw | WeakPair | MidPair | TopPair | Overpair | TwoPair | Monster |
|---|---|---|---|---|---|---|---|---|---|
| flop (3) | 0.334 | 0.412 | 0.514 | 0.571 | 0.682 | 0.776 | 0.796 | 0.855 | 0.927 |
| turn (4) | 0.279 | 0.322 | 0.392 | 0.551 | 0.699 | 0.773 | 0.756 | 0.831 | 0.883 |
| river (5) | 0.227 | — | — | 0.524 | 0.701 | 0.782 | 0.791 | 0.836 | 0.899 |

Measurement overruled intuition twice, and both results are worth stating because both contradict the obvious guess.

**A bare flush draw ranks below bottom pair.** StrongDraw measures 0.514 on the flop and 0.392 on the turn; WeakPair measures 0.571 and 0.551. Draws feel stronger than that because they are usually held alongside something — and this bucket is what is left once that something has been classified on its own.

**Top pair and an overpair are the same rung.** They measure 0.776 / 0.796 on the flop, 0.773 / 0.756 on the turn, 0.782 / 0.791 on the river: the sign of the gap flips with the boards drawn. The test therefore declines to assert an order between them and bounds only the direction that would be a defect (`gain > -0.02`), rather than asserting sampling noise. It is worth being explicit about why the weaker assertion is the honest one: `Math.abs(gain) < 0.08` would pass just as happily on a real eight-point inversion, which is larger than any genuine gap elsewhere on the ladder.

### Preflop bands
With no board there is nothing to classify against, so the ladder falls back to bands of the Chen `holeScore`. The cut points sit on the score's own quantiles rather than on round numbers, because the score is lumpy: it takes only 17 distinct values over the 1326 combos and 236 of them score exactly 5. The resulting combo counts, pinned by test, are

$$
[436,\ 316,\ 236,\ 102,\ 94,\ 54,\ 30,\ 30,\ 28]
$$

from Air up to Monster — roughly 33 / 24 / 18 / 8 / 7 / 4 / 2 / 2 / 2 percent of the deck, which is the shape a preflop range chart actually has. Even cuts on the score's *range* would put 0.5% in the top band and 42% in one middle one.

### Auditing the taxonomy against the potential-aware literature
Ordering by mean equity is **expected hand strength**, and EHS is the metric the abstraction literature rejects. Ganzfried & Sandholm state the defect exactly: EHS "fails to account for the entire probability distribution of hand strength" (*Potential-Aware Imperfect-Recall Abstraction with Earth Mover's Distance*, AAAI-14, §1). Johanson et al. make the same point: E[HS] "summarizes the distribution over possible end-game strengths into a single expected value", which "is unable to distinguish hands with differing potential to improve" (*Evaluating State-Space Abstractions in Extensive-Form Games*, AAMAS-13, §4).

So the ladder was re-audited with distributions rather than means (`src/poker/model/distribution.ts`). A combo's **hand-strength distribution** is the histogram of its final equity over the ways the board can still run out, binned into $\text{DIST\_BINS} = 50$ regions of width 0.02 — 50 because the literature is 50, which is what makes the numbers comparable to published tables rather than only to themselves.

Two histograms are compared with the **Earth Mover's Distance**: "the minimum cost of turning one pile into the other, where the cost is assumed to be amount of dirt moved times the distance by which it is moved". For histograms on a line the minimum has a closed form — the $L_1$ distance between the cumulative distributions — so the whole computation is one pass with a running carry:

```ts
let carry = 0, work = 0;
for (let i = 0; i < DIST_BINS; i++) {
  carry += a[i] - b[i];
  work += carry < 0 ? -carry : carry;
}
return work;
```

EMD rather than $L_2$ because $L_2$ "does not properly account for how far the 'dirt' needs to be moved (only how much needs to be moved)". Two histograms with disjoint support are equidistant under $L_2$ whether the gap is one bin or forty; under EMD they are not, and in poker that gap is the whole question. Formally $\text{EMD}(a,b) \ge |\text{mean}(a)-\text{mean}(b)| / \text{BIN\_WIDTH}$ always, with equality exactly when one distribution stochastically dominates the other — which is the precise sense in which EMD sees everything a difference of means sees, and more.

**The published example reproduces.** Ganzfried & Sandholm's illustration is KcQc against 6c6d, "expected hand strengths of 0.634 and 0.633 respectively, which suggests that they have very similar strength". Measured here over 20,000 sampled runouts: KcQc 0.6334, 6c6d 0.6342, a difference of 0.0007. And the distributions behind those numbers are 5.300 bins apart, against the 5.286 Johanson et al. publish for the same pair (AAMAS-13, Figure 2, where QsKs and 6s6h are the same two hands up to suit) — within a bin, which is the check that this is the literature's EMD and not merely something with the same name. The paper's description of the shapes reproduces too: 6c6d puts 0.484 of its mass in [0.5, 0.7] against 0.131 in [0.7, 0.9], and KcQc is the reverse at 0.082 / 0.346.

**The ordering survives.** Searching **all $9! = 362{,}880$** orderings for the one whose bucket-centroid EMD matrix is most monotone away from the diagonal (a Robinson-matrix criterion) returns *this* order on every street: the flop's enumeration order has 1 violation and the best of 362,880 orderings also has 1; the turn has 0 and the best is 0; the river has 0 among the $7! = 5{,}040$ orderings of its populated buckets. Two unrelated metrics — mean equity and distributional distance — agreeing about the ladder is worth more than either alone.

**The clusters are real.** Hands sharing a bucket are about three times closer in EMD than hands drawn from different ones (flop 5.20 vs 15.03 bins, turn 5.36 vs 16.94, river 7.67 vs 22.36), and nearest-neighbour purity is 99.5% on the flop and 100.0% on the turn.

### What the audit does not excuse
The tails are bad, and they are a limit of having nine classes rather than of how they are ordered. On K♠ 7♠ Q♣ the flop puts 2c3c (a backdoor flush) and JcAs (a gutshot to Broadway, ace high) both in WeakDraw at an EMD of 21.11 bins — further apart than Air is from WeakPair. On the four-flush board K♦ Q♦ 3♦ 9♦, Monster holds both TdJd (a straight flush) and TsJs (the same straight, losing to every diamond) at 21.20 bins. Nine hand-crafted classes have nowhere to put "ace-high with a gutshot" or "the straight that a flush board has already beaten".

Fixing that means more classes, which means k-means over distributions with a free cluster count — i.e. genuinely **potential-aware** abstraction, which recurses over histograms of next-round *clusters* rather than stopping at final-round strength. `BUCKET_COUNT` is frozen by the persisted cell keys the likelihood model builds from these ids (§7), so it is not a change that can be made in one module. The measurement apparatus reports how much the current taxonomy leaves on the table; it cannot collect it.

---

## 5. Multiway Equity by Monte Carlo

### Why Monte Carlo is needed
The bot must estimate its share of the pot. In principle this is a finite combinatorial sum. Preflop, with 50 unknown cards, a single opponent has $\binom{50}{2}=1225$ possible hands, and for each the remaining 5 board cards can be chosen $\binom{48}{5}=1{,}712{,}304$ ways — on the order of $2\times10^{9}$ joint outcomes, before adding a second opponent. Exact enumeration on every click is infeasible, so the engine **estimates** the expectation by random sampling: replace an intractable exact average with the sample mean of i.i.d. draws.

### Beating everyone, and what a chop is worth
The heads-up sampler answers "do I beat him?". `src/poker/equity/multiway.ts` answers "do I beat *all* of them?", and the two questions come apart fast. The hero must be strictly best to win outright, so the field's chance of holding *something* compounds with every extra seat: a hand that is 65% against each opponent taken alone can be a clear underdog to three of them together.

That forces a second distinction, and it is the single easiest thing to get wrong in the move from heads-up to multiway. A $k$-way chop is worth $1/k$ of the pot, so the value of a holding is

$$
\text{equity} = \frac{\text{wins} + \sum_{\text{chops}} 1/k}{N}
\qquad\text{not}\qquad
\widehat{\Pr}(\text{win}) = \frac{\text{wins}}{N}.
$$

Heads-up the two are within a tie's width of each other — a chop is worth exactly half, and ties are rare — which is why the old `actionEv` could take `pWin` and be right. Four-handed, a hand that chops a quarter of the time is collecting real chips that `pWin` scores as zero, and a four-way chop is worth a quarter of the pot rather than half. `decider.evInput` therefore substitutes `equity` for `pWin` before any EV is computed, and both are reported so the gap is visible.

The chop sizes are accumulated as a **histogram** (`tieBySize[k]` counts sims split $k$ ways) rather than as a running $\sum 1/k$. That keeps every shard's counters integral, which is what lets shards merge by addition without the total depending on shard arithmetic order (§10).

### Sampling the field: whole-tuple rejection
Opponents share one deck, so the field must be drawn as one object. The kernel proposes every seat's hole cards from that seat's own range and, **if any two seats want the same card, throws the whole tuple away and starts over**. The law that survives is $\prod_i p(h_i)$ conditioned on the hands being pairwise disjoint — symmetric under relabelling the seats, which is the point.

The obvious cheaper alternative is to redraw only the offending seat. That is not the same distribution, and the difference was measured rather than assumed. Per-seat rejection conditions each seat on the ones dealt before it: early seats took strong cards more often and later seats drew from a pool already stripped of them, so `perOpponent` came out monotone in seat order. At 400,000 simulations the spread was **0.0037 / 0.0108 / 0.0184 at 2 / 4 / 6 opponents — 5 / 16 / 27 standard errors**. It was a real number in the analysis interface that meant nothing but the order the array happened to be in.

The price of the fix is paid in the tuple loop. Acceptance is the chance that $N$ independent range draws happen to be pairwise disjoint, which falls off with the field and faster the sharper the reads. Measured over a 50-card pool: a flat range at every seat accepts 0.920 at two opponents, 0.598 at four and 0.269 at six; ranges reweighted by three streets of betting accept 0.851 / 0.375 / 0.191. In wall clock, whole-tuple rejection is a wash up to two opponents, 1.1× at four and **1.6× at six** with ordinary reads — and none of it lands in the scoring.

`MAX_TUPLE_ATTEMPTS = 256` bounds the loop. At the sharpest realistic acceptance rate that bound fires with probability $\approx 4\times10^{-25}$ per simulation, so it is not what makes the ordinary cases work. It exists for the degenerate one: with two seats pinned on ranges whose only combo is the same combo, no disjoint tuple exists at all and nothing but a bound terminates the loop. The documented fallback deals the whole field uniformly, which cannot fail (a pool-size guard reserves two cards per seat) and is itself exchangeable, so the escape hatch does not smuggle the seat-order artifact back in.

### Per-opponent equity is free
The hero beats the field iff it beats the best opponent, and each comparison made along the way *is* the heads-up result against that seat. So one pass gives both answers:

```ts
let bestOpp = -1, tiedWithHero = 0;
for (let o = 0; o < N; o++) {
  const sc = scoreInts(oppHands[o], handSize);
  if (sc > bestOpp) bestOpp = sc;
  if (heroScore > sc) h2hWins[o]++;
  else if (heroScore === sc) { h2hTies[o]++; tiedWithHero++; }
}
```

`perOpponent[i] = (w_i + t_i/2)/N` never needs a second run.

### The estimators, unbiasedness, and error
Let $N$ be the number of simulations and $X_s=1$ if the hero's best 5-card hand beats every opponent's. Each $X_s$ is an i.i.d. Bernoulli$(p)$ draw with $p=\Pr(\text{win})$, so $\mathbb{E}[\widehat p] = p$ (unbiased) and $\operatorname{Var}(\widehat p)=p(1-p)/N$. The standard error is

$$
\mathrm{SE}(\widehat p)=\sqrt{\frac{p(1-p)}{N}} \le \frac{1}{2\sqrt N},
$$

the bound being the worst case over $p$, since $p(1-p)$ peaks at $p=\tfrac12$.

### Why the reported interval is Wilson's, not $\widehat p \pm z\,\mathrm{SE}$
The Wald interval built from the expression above degenerates exactly where poker spends much of its time: on a decided river $\widehat p$ is 0 or 1, so $\widehat{\mathrm{SE}} = 0$ and the interval collapses to a point, claiming certainty from a finite sample. The engine therefore reports the **Wilson score interval**, the set of $p$ satisfying $(\widehat p - p)^2 \le z^2 p(1-p)/N$:

$$
\frac{\widehat p + \frac{z^2}{2N} \pm z\sqrt{\dfrac{\widehat p(1-\widehat p)}{N} + \dfrac{z^2}{4N^2}}}{1 + \frac{z^2}{N}}.
$$

Because the bound is derived from the *true* $p$ rather than the estimate, it stays inside $[0,1]$ and retains positive width at $\widehat p \in \{0,1\}$ (`src/poker/core/stats.ts`, `wilsonInterval`, at $z = 1.959964$). At the extremes the two endpoints are equal only to within rounding, leaving ~$10^{-20}$ of dust, so $k=0$ and $k=n$ are snapped rather than clamped with an epsilon. The report surfaces the Wilson interval next to both the Wald standard error and the crude worst-case bound $\pm 100/\sqrt N$, so the gap between them is visible rather than hidden (`src/components/report/MathTab.tsx`).

### How many simulations, and why
The live table's budget is per-street and per-field-size (`src/poker/model/decider.ts`):

```ts
export const TABLE_DECISION_SIMS = {
  preflop: 20000, flop: 20000, turn: 15000, river: 10000,
};
export const MIN_DECISION_SIMS = 5000;

export function decisionSims(street: Street, opponents: number): number {
  const base = TABLE_DECISION_SIMS[street === "showdown" ? "river" : street];
  return Math.max(MIN_DECISION_SIMS, Math.round(base / Math.max(1, opponents)));
}
```

Two separate arguments are encoded here.

**Across streets, the counts decrease** because the variance of the per-sim outcome shrinks as information accrues. On the river there are zero unknown board cards, so only the opponents' hands are random and far fewer samples achieve the same standard error. Early streets carry higher-dimensional randomness and so get more.

**Across field sizes, the counts decrease** because a multiway sim scores one hand *per opponent* where a heads-up sim scores one. Dividing by the opponent count holds the *work* per decision roughly constant instead of the sample count — a six-handed pot must not cost five times a heads-up one on the live path — with a floor at 5,000, below which the standard error on a coin-flip spot passes 0.7% and the noise becomes visible as the bot changing its mind between two nearly-equal actions.

**Why counts of this size and not smaller ones.** A decision is an $\arg\max$ over a handful of EVs, so the quantity that matters is not the error on $\widehat p$ but whether that error is large enough to **reorder the maximum**. That is the rule the budget is set by, and it was calibrated by direct measurement against a 600,000-sim reference over 60 real decision points with 12 seeds each: at counts of 7000/7000/5000/3000 the engine chose a different action than ground truth on $3/720$ trials, and at roughly six times those counts, $0/720$. The mean spread of $\widehat p$ across seeds fell from $0.0178$ to $0.0071$ — a factor of $2.5 \approx \sqrt 6$, exactly the $O(1/\sqrt N)$ the theory predicts for a $6\times$ increase, which is what confirms the improvement is the sample count and not a coincidence of seeds.

Fold-equity runs get their own, smaller budget: `FOLD_EQUITY_SIMS = 800`, paid once per rung of the sizing ladder. That is deliberate. The showdown estimate decides between folding and calling, where a 1% error changes the answer; this one decides between two bet sizes whose EVs are usually within a few percent of each other anyway. 800 puts the standard error near 1.7% on a coin-flip spot.

### Equity as a martingale
Post-hand, the review plots each matchup's equity at every street that was reached. This is the one question a hand review is uniquely able to answer honestly: at the table nobody knew the opponent's cards, but the report has them, so the number needs no read, no range and no belief — only the evaluator and the cards the deck had left (`src/components/report/derive.ts`, `headsUpEquity`):

$$
\text{equity}_{\text{street}} = \Pr\big(\text{hero wins} \mid H_{\text{hero}}, H_{\text{opp}}, B_{\text{street}}\big),
$$

with chops split, so it is on the same pot-share scale as everything else. It is **enumerated exactly** wherever two or fewer cards remain — 44 runouts on the turn, one on the river — and sampled from a fixed seed only preflop, so the same hand reviewed twice cannot show two different numbers.

Each revealed board card is information that conditions the probability, so by the tower property equity is a **martingale** in the information filtration $\mathcal{F}_{\text{preflop}}\subseteq\mathcal{F}_{\text{flop}}\subseteq\dots$:

$$
\mathbb{E}\big[\text{equity}_{\text{river}} \mid \mathcal{F}_{\text{flop}}\big] = \text{equity}_{\text{flop}}.
$$

The next street's equity is an unbiased refinement of the current one, but its realized value jumps as the conditioning set grows, and its variance falls to zero by the river where $\mathcal{F}_{\text{river}}$ determines the winner exactly. That is why the lines fan out toward 0% and 100% as a hand progresses — and why the last rung is not an estimate at all but a fact, drawn on the same axis as the probabilities because it is the same quantity seen with a different amount of the deck showing.

The reconstruction is faithful to the information available *at* each street: the flop point uses `board.slice(0, 3)` even though all five cards are known afterwards. Note also what the panel deliberately does **not** do. A bot's recorded `perOpponent[x]` is its own cards against a hand sampled from its read on $x$, so it is only ever the equity of the seat that recorded it; inverting it to fill in the other chair would produce a figure the reviewing seat's real cards never entered — identical whether that seat held aces or 7-2. Post-hand there is no need for the substitution at all, so the panel simply runs both real hands out and reports what the matchup actually was.

### Splitting the estimate across workers
A Monte Carlo run is a sum of independent trials, so it parallelizes exactly: the run is cut into shards, each drawing from its own stream $H(\text{seed}, i)$, and the shard counts are summed before a single normalization. Since $\sum_i W_i / \sum_i N_i$ is the same estimator as the unsharded one, sharding changes the wall clock and nothing else.

Two details keep it reproducible (`src/poker/equity/pool.ts`):

```ts
/** Deliberately decoupled from the worker count. */
const SHARDS = 4;
```

The shard count is a **constant**, independent of how many CPU cores the machine reports — cores decide only which shard runs where — and merging is by summation in shard order, not completion order (`Promise.all` resolves in input order). A 2-core and a 16-core machine therefore produce bit-identical results, and so do the worker path and the in-process fallback, because both go through the same `runShard`.

---

## 6. Expected Value, Fold Equity, and Sizing

### Purpose and why EV dominates win probability
Win probability alone is insufficient for a betting decision: a 30%-equity call can be correct if the pot is large relative to the cost, and an 80%-equity call can be unprofitable if the price is wrong. The bot therefore chooses by **expected value** — the average chip outcome of an action — not by equity.

### The forward-looking model (unchanged, and still exact where it applies)
The engine measures from the decision point: chips already in the pot are sunk and ignored; only chips risked *now* and the pot that can be won enter the calculation. This is what makes folding ever correct. One function computes it (`src/poker/ev.ts`):

```ts
export function actionEv(action, mc, pot, toCall): number {
  if (action.type === "fold") return 0;
  const extra = Math.max(0, action.cost - toCall);
  return mc.pWin * (pot + extra) - mc.pLoss * action.cost;
}
```

With $p$ the hero's pot share, $q = 1-p$, pot $P$, and $\text{extra} = \max(0, \text{cost}-\text{toCall})$:

$$
\mathbb{E}[\text{action}] = p\,(P + \text{extra}) - q\cdot\text{cost}.
$$

Specializing gives the familiar cases: $\mathbb{E}[\text{Fold}] = 0$ (the baseline — an action is only chosen over folding if its EV exceeds 0); $\mathbb{E}[\text{Check}] = p\cdot P$; $\mathbb{E}[\text{Call}] = p\,P - q\,\text{toCall}$, whose positivity is the classic pot-odds rule $p/q > \text{toCall}/P$; and $\mathbb{E}[\text{Bet}] = p(P+\text{cost}) - q\,\text{cost}$.

This formula is **not superseded**. It carries two assumptions, and it remains exactly right wherever both hold:

1. *The bet is always called.* True by construction for checks, folds and calls, none of which have a fold-equity term.
2. *The pot is final.* True for a call that **closes** the action — heads-up, or last to act with everybody else already matched — because every chip that will ever enter the pot is already in it.

The two subsections below are the versions that drop one assumption each. `closesAction` is the single predicate that decides which price applies, read by both the entry gate and the pricing so the two cannot drift apart.

### Fold equity: what the old bot could not do
`actionEv` is blind to the fact that a bet wins two different ways. A hand with no showdown value can therefore never profitably bet — the old bot **could not bluff, mathematically**. The general formula is

$$
\mathbb{E}[\text{bet } s] = \Pr(\text{fold}\mid s)\cdot P \;+\; \big(1 - \Pr(\text{fold}\mid s)\big)\cdot\Big[E_{\text{cont}}\,(P + 2s) - s\Big].
$$

The bracket is the same arithmetic `actionEv` does, with $E_{\text{cont}}$ substituted for $p$: $E(P+s) - (1-E)s = E(P+2s) - s$. That identity is why this is an *extension* of the old formula rather than a rival to it.

The load-bearing term is $E_{\text{cont}}$. It is the hero's equity against the part of the opponent's range that **continues** against a bet of $s$ — not equity against the whole range, and always worse when folding is strength-correlated, because the hands that fold are the weak ones and what is left facing the bet is the strong tail. The continuing range is derived by weighting each combo by $1 - \Pr(\text{fold} \mid \text{bucket}(h))$ and renormalising, which is exactly the posterior over the opponent's holding conditioned on "did not fold":

$$
R_{\text{cont}}(h) \;\propto\; R(h)\,\big(1 - \Pr(\text{fold}\mid \text{bucket}(h))\big).
$$

Pricing a bluff against equity-vs-range instead of equity-vs-callers systematically overvalues betting, which is a *worse* failure than never bluffing at all: it turns every missed draw into a "profitable" bet against a range that has already folded its air. The gap between the two is reported explicitly (`eRange` vs `eContinue`) so it can be read rather than trusted. Measured on one flop fixture with a single opponent (`src/poker/ev.test.ts`): 7-2 as air has $E_{\text{range}} = 0.1845$ but $E_{\text{cont}} = 0.0473$, while K-Q as top pair has $E_{\text{range}} = 0.8668$ and $E_{\text{cont}} = 0.7549$. The air hand loses three quarters of its apparent equity to the selection effect; the made hand loses a tenth.

That the bet is nevertheless correct with the air hand — and only against the right opponent — is the whole point. Against a fold-prone seat ($\Pr(\text{fold}) = 0.600$) checking is worth 18.45 and betting 43.83; against a calling station ($\Pr(\text{fold}) = 0.020$) checking is still worth 18.45 and betting is worth $-9.60$.

### $\alpha$ and the minimum defence frequency, derived
Set $E_{\text{cont}} = 0$ — a pure bluff, no equity at all. The formula collapses to

$$
\mathbb{E} = \Pr(\text{fold})\cdot P - \big(1-\Pr(\text{fold})\big)\cdot s,
$$

which is zero exactly at

$$
\boxed{\ \alpha = \frac{s}{P+s}\ }
\qquad\text{and}\qquad
\text{MDF} = 1-\alpha = \frac{P}{P+s}.
$$

$\alpha$ is the break-even bluffing frequency; MDF is the fraction of range an opponent must continue with to stop a pure bluff being automatically profitable. The published ladder falls straight out, and `src/poker/ev.test.ts` pins all of it against this implementation to floating-point tolerance — the measured EV at $\Pr(\text{fold}) = \alpha$ is between $-1.8\times10^{-13}$ and $+5.3\times10^{-13}$ across the table:

| pot $P$ | bet $s$ | $\alpha$ | MDF |
|---|---|---|---|
| 100 | 50 (½ pot) | 33.3% | 66.7% |
| 100 | 75 (¾ pot) | 42.9% | 57.1% |
| 100 | 100 (pot) | 50.0% | 50.0% |
| 100 | 200 (2× pot) | 66.7% | 33.3% |
| 37 | 11 | 22.9% | 77.1% |

This identity is the external check on the whole module: it is a closed-form result from the literature rather than a property of this code, so if the two disagree, this code is wrong. Everything else about fold equity is a behavioural claim; this one is arithmetic. The tests also confirm it is a genuine crossing — EV is negative at $\alpha - 0.02$ and positive at $\alpha + 0.02$ — and that a bluff with some equity beats a pure one at the same $\alpha$.

### MDF as a constraint on the *prior*
The same identity bounds what the opponent model is allowed to believe. An opponent folding more than $\alpha$ can be beaten by betting any two cards, so an unexploitable one folds at most $\alpha$.

The generated prior's uncapped rows folded **46.4%** of a range to a half-pot bet: 13 points looser than any unexploitable opponent. Every bet and raise in the game is priced against that table, so those 13 points were a standing subsidy on aggression, and an EV maximiser correctly collected it by betting close to everything. `MDF_FOLD_SCALE = 0.47` removes the subsidy (`src/poker/model/likelihood.ts`).

Three details make the cap principled rather than a fudge.

**What is anchored is the range-weighted fold frequency** — the share of the hands an opponent actually holds that go in the muck, which is what the EV integral sees. Not the flat mean over the nine buckets: a random range is air-heavy and air is what folds, so the range-weighted rate runs 6–12 points above the per-bucket mean, and pinning the smaller number would leave the one that prices a bet still over the line.

**One size is enough**, because the sizing law has the MDF frontier as a **fixed point**. Measure the bet $s$ as a fraction of the pot, so $P = 1$. Then $\alpha = s/(1+s)$, which in odds form is exactly

$$
\frac{\alpha}{1-\alpha} = s.
$$

`foldAtSize` shifts the log-odds of a fold by $\log(s/f_{\text{ref}})$ at unit sensitivity, i.e. $\text{odds}(s) = \text{odds}(0.5)\cdot 2s$. So setting $\text{odds}(0.5) = 1/2$ — that is, $p = 1/3$, which is precisely $\alpha$ at half pot — gives $\text{odds}(s) = s$ at *every* size. Anchoring the one reference size therefore holds the whole curve on the frontier, which is why a single scalar suffices where a per-size table might have been expected. Measured at 0.50 / 0.75 / 1.00 pot the capped rows come out at 32.4 / 41.3 / 47.9% facing a bet and 32.6 / 41.7 / 48.5% facing a raise, against $\alpha$ of 33.3 / 42.9 / 50.0%.

**A single scalar, applied between fold and call only.** MDF constrains the total share of a range that folds, not how that share is spread over hand classes; the prior's spread was never the problem, its level was. Scaling both defended nodes by the same factor also preserves the facing comparison exactly — a three-bet still folds out more than a bet does from every single bucket, because a shared positive factor cannot reorder anything. Two separately-solved factors did invert that at the air bucket.

### Fold equity dies exponentially in the field
With $N$ opponents a bet only wins uncontested if **every** one folds, taken here to be $\prod_i \Pr(\text{fold}_i)$. That product is an approximation: the opponents' ranges are coupled by card removal, so their folding decisions are weakly dependent, and the error runs one way — the product overstates how often a whole field folds, making the bot slightly over-optimistic about bluffing into a field.

The decay itself is not an artifact of that assumption, and it is the real lesson. Measured on one fixture (`ev.test.ts`), with the air hand from above and pot-size bets:

| opponents | $\Pr(\text{all fold})$ | $E_{\text{cont}}$ | EV |
|---|---|---|---|
| 1 | 0.600 | 0.047 | $+43.83$ |
| 2 | 0.360 | 0.041 | $+9.43$ |
| 3 | 0.216 | 0.035 | $-11.77$ |
| 5 | 0.078 | 0.026 | $-32.61$ |

Bluffing multiway is bad long before any second-order dependence matters, and the bot learns this without being told: the share of air hands it bets falls from 93.4% heads-up to 46.3% / 25.0% / 14.7% against two / three / five opponents.

### The expectation of a product is not the product of the expectations
This is the genuine probability lesson in the module, and it was a live bug. The call branch is worth

$$
\mathbb{E}\Big[\,\text{share}\cdot\big(P + \textstyle\sum_{\text{continuing}} \text{owes}\big) - (1-\text{share})\cdot \text{cost}\,\Big].
$$

The module used to compute

$$
\mathbb{E}[\text{share}]\cdot\big(P + \mathbb{E}[k]\cdot s\big) - (1-\mathbb{E}[\text{share}])\cdot \text{cost}
$$

instead — a **factorisation of an expectation of a product**. Heads-up the two agree exactly, because $k \equiv 1$ and there is nothing to correlate. Multiway they do not: the hero takes a smaller fraction of the pot in exactly the simulations where more opponents stayed to contest it, so share and field size are **negatively correlated** and

$$
\mathbb{E}[\text{share}]\cdot\big(P + \mathbb{E}[k]\,s\big) \;>\; \mathbb{E}\big[\text{share}\cdot(P + k\,s)\big]
$$

strictly, whenever $k$ varies at all. The gap runs entirely in the "betting looks better" direction, and it *grows* with the field, because it is driven by the variance of $k$ — the same direction and the same growth as the independence error above, which is why the note that once excused it ("the $\prod$ decay dominates") was wrong.

The size is pinned against closed-form arithmetic rather than against the implementation. With four opponents each folding at 0.4 and each beating the hero with probability 0.45, betting 200 into a pot of 100, the exact value and the factorised value can both be written down by hand, and they differ by **24.5815 chips**. Read as a decision, the same spot is worth $+12$ chips under the factorisation and $-12$ under the honest arithmetic, against a check worth 0 — the sign, and therefore the decision, flips.

The fix is structural rather than a correction term: the call term is accumulated **one simulation at a time**, with that simulation's own share and its own field, inside `runField`:

```ts
if (payoff !== null) {
  let potIfCalled = payoff.pot;
  for (let i = 0; i < n; i++) if (inField[i]) potIfCalled += payoff.owes[i];
  evSum += share * potIfCalled - (1 - share) * payoff.cost;
}
```

`eContinue` and `callers` survive only as *reporting*, and both are documented as such, so nothing can rebuild the price out of them by accident.

### Choosing the size
Each rung of the ladder is priced with its own continuing range, because that is the point: a bigger bet folds out more of the opponent's range, which raises the fold term and lowers the equity of what is left. Pricing every size against one shared continuing range would reintroduce the same error one level up. All rungs share a seed — common random numbers — so the $\arg\max$ compares sizes on the same sampled boards rather than on their sampling noise.

The fold rate at a size is a log-odds shift from the reference (`src/poker/model/decider.ts`):

$$
\text{odds}(f) = \text{odds}(f_{\text{ref}})\cdot\left(\frac{\min(f,\,f_{\max})}{f_{\text{ref}}}\right)^{k},
\qquad f_{\text{ref}} = 0.5,\ k = 1,\ f_{\max} = 1.
$$

Working in log-odds keeps this a probability at both ends with no clamp: an opponent that never folds still never folds however large the bet, and the curve is monotone in size. The cap $f_{\max}$ is doing real work. A logistic stretched from half pot out to a twenty-times-pot shove says every bucket folds ~96% — aces included — because a uniform shift in log-odds moves $p=0.44$ and $p=0.60$ by the same odds ratio and the two converge on 1 together. The strength correlation *is* what fold equity is priced from, so losing it makes a shove with the worst hand at the table read as the highest-EV action on the board. It did, before the cap: 72o for $+5.4$ into a \$15 pot.

The per-bucket fold rates are renormalised over the moves actually available, since facing a bet the only choices are fold, call and raise and the prior parks ~2% on the two illegal ones:

$$
\Pr(\text{fold}\mid b) = \frac{\Pr(\text{fold}\mid b)}{\Pr(\text{fold}\mid b)+\Pr(\text{call}\mid b)+\Pr(\text{raise}\mid b)}.
$$

### Pricing a call on the same basis as a raise
`actionEv` prices a call against the pot **as it stands**. For a call that does not close the action that is wrong, and wrong on both legs of one expression. The equity a call is priced with is the hero's share against the *whole* field still contesting, seats behind included — so the losing leg already pays for those seats sticking around. The winning leg does not collect for it: the pot it wins is the pot from before any of them called.

Six-handed preflop that pairs a share of ~1/6 with a pot of one and a half blinds:

$$
\text{call} = \text{share}\times P - (1-\text{share})\times\text{toCall} \approx -4,
\qquad
\text{raise} = \text{share}\times(P + \textstyle\sum \text{owed}) - (1-\text{share})\times\text{cost} \approx +12,
$$

for the same holding. The raise is on the right basis; the call is on a basis that assumes a six-way showdown for a heads-up pot. The two are therefore not comparable at all, and the bias is not small: over 220 six-handed hands the call came out negative while the best aggressive line came out positive in **37.5%** of spots. A profile's aggression tilt is a multiplier, and multipliers preserve sign, so no personality setting could reorder any of them.

The fix is to price a non-closing call against the pot it will plausibly **reach**, with the same field simulation a raise is priced with: each seat that still owes chips continues at its own $\Pr(\text{continue})$, at the price *it* is being offered, and the hero's share is taken against the field that actually shows up, one simulation at a time. Measured on two fixtures: a call worth $-15.28$ on the standing pot of 100 is worth $-7.17$ on the reached pot of 119.8; six-handed with three seats behind, $-17.50$ becomes $-15.82$.

**What must not come with it is fold equity.** Nobody folds to a call. The seat whose bet is being called has already committed and has no decision left, so the "everybody folds and the hero takes the pot" branch is unreachable. That is why `callEv` is a *specialisation* of `foldEquityEv` rather than another call of it with different numbers: zeroing the fold model of every already-matched seat drives $\Pr(\text{all fold})$ to 0 **by construction**, and the formula collapses onto its call term alone. A raise therefore still beats a call whenever the folds it buys are genuinely worth something, which is the asymmetry the whole bot roster rests on.

### How the bot chooses
With every price on one basis, the decision is an $\arg\max$ over action *types and sizes* together:

$$
a^\star = \arg\max_{a\in\mathcal{A}(\text{state})} \mathbb{E}[a],
$$

after which the seat's profile may bend the answer — entry discipline, a bluff frequency, an aggression tilt — into the move actually taken (`src/poker/model/profiles.ts`). Every candidate EV is stored regardless of which won, which is what makes §11 an audit rather than a reconstruction.

---

## 7. Bayesian Inference and Conditioned Likelihoods

### Purpose
The bot cannot see anyone's cards, so it maintains beliefs about them and revises those beliefs after every action, using Bayes' theorem. Those beliefs are what the equity sampler draws from.

### Bayes' rule (unchanged)
By the definition of conditional probability, $\Pr(H\mid A)=\Pr(H,A)/\Pr(A)$ and $\Pr(H,A)=\Pr(A\mid H)\Pr(H)$, so

$$
\Pr(H\mid A) = \frac{\Pr(A\mid H)\,\Pr(H)}{\sum_{H'} \Pr(A\mid H')\,\Pr(H')},
$$

the denominator being the law of total probability. `src/poker/bayesian.ts` implements it literally, computing the unnormalized numerators and dividing by their sum.

The three-tier form still runs, once per seat, over the hand's public record (`decider.readsFromActions`): each seat starts on `INITIAL_BELIEF` $=(0.40,\,0.35,\,0.25)$ and is moved by `updateBelief` for each action it took. Reads are built from **public information only** — no seat's hole cards are consulted — so a bot's read on you is exactly what you could work out yourself, and the Study mode that displays these is showing the bots' actual information set rather than a privileged one.

**The worked example still holds exactly.** Start from $\Pr(H)=(0.40,\,0.35,\,0.25)$ for (weak, medium, strong). The opponent **raises**; the default likelihood row is $\Pr(\text{raise}\mid H)=(0.05,\,0.25,\,0.70)$. Unnormalized numerators:

$$
0.05\times0.40 = 0.0200,\qquad 0.25\times0.35 = 0.0875,\qquad 0.70\times0.25 = 0.1750,
$$

evidence $\Pr(\text{raise}) = 0.2825$, posterior

$$
\Pr(H\mid\text{raise}) = \left(\tfrac{0.0200}{0.2825},\ \tfrac{0.0875}{0.2825},\ \tfrac{0.1750}{0.2825}\right) \approx (0.0708,\ 0.3097,\ 0.6195).
$$

A single raise moves the belief that the opponent is strong from 25% to $\approx 62\%$ while weak collapses from 40% to $\approx 7\%$. `likelihood.test.ts` reproduces these exact numbers through the *new* model configured with its `legacy` prior, which is the concrete sense in which the old model was generalised rather than replaced.

### The flat table is an average, not a tell
`src/data/constants.ts` ships a flat $3\times5$ table: one $\Pr(\text{action}\mid\text{tier})$ row that is the same preflop and on the river, in the big blind and on the button, unopened and facing a three-bet. The identical raise means completely different things in those spots, and a model that cannot say so cannot tell a player anything they did not already know. Folding is not even *legal* unopened, so pooling that node with the others corrupts the fold rate as well.

`src/poker/model/likelihood.ts` conditions on four axes:

$$
\Pr(\text{action} \mid \text{bucket},\ \text{street},\ \text{position},\ \text{facing}),
$$

with 9 buckets × 4 streets × 6 positions × 3 facings = **648 cells**. `facing` $\in$ {unopened, facing-bet, facing-raise} is the axis the flat table is most obviously missing: "raise" unopened is a bet, "raise" facing a bet is a raise, and "raise" facing a raise is a three-bet.

### The generated prior
$9 \times 4 \times 3 = 108$ rows of five numbers is too many to hand-author honestly — nobody can keep 540 hand-typed probabilities self-consistent — so they are generated from six constants, each of which means something:

$$
w(a) \;=\; \text{base}(a, \text{facing})\cdot \exp(\text{role exponent}),
$$

where an action's **role** is facing-relative (`check` is the give-up option unopened, `call` is the middle option facing a bet, `bet` and `raise` are the same act at different nodes) and the exponent scales with hand strength $\tau \in [-1, 1]$ and street sharpness $\gamma$:

$$
\text{aggro}: +\gamma\tau,\qquad \text{give}: -\gamma\tau,\qquad \text{call}: -0.8\,\gamma\tau^2 .
$$

Calling is the *middle* action, not a weak one: it peaks at medium strength and falls off at both ends (nothing to call with, or too good to just call). A quadratic in the strength tilt is the cheapest shape with that property.

$\gamma$ runs 0.55 preflop, 0.8 flop, 1.0 turn, 1.25 river. Preflop everybody is playing a range against a range and much of the action is mechanical — the big blind defends 72o because it is already half paid in — so the tell is weak; by the river the hand is complete and the correlation between what you hold and what you do is at its maximum.

Finally 8% of each row is replaced by a uniform mix (`PRIOR_MIX = 0.08`), capping the Bayes factor a single action can carry at roughly 1 : 30. Without it the river rows get polarised enough that one check would zero out the "strong" hypothesis, and a model whose output is shown to the player must never claim certainty from one action. Actions that are not legal at a node get weight 0.01 rather than 0, for the same reason: a hard zero would make one mislabelled observation an infinitely strong Bayes factor.

### The sparsity problem, and the six-level backoff
648 cells against a few hundred decisions a session means most cells are empty forever. Six nested estimates are therefore maintained per player, ordered by how fast each fills with data, and **every observation writes to all of them at once**:

| level | conditioning | cells |
|---|---|---|
| 0 | global — every decision ever | 1 |
| 1 | (street, facing) | 12 |
| 2 | (bucket) | 9 |
| 3 | (bucket, street) | 36 |
| 4 | (bucket, street, facing) | 108 |
| 5 | (bucket, street, facing, position) | 648 |

A lookup starts at the data-free prior row and walks the list coarse to fine, applying the smoothing below at each level **with the previous level's answer as the prior mean**. Because $\text{betaMean}(0,0,m) = m$ exactly, a level with no evidence is the identity: an empty cell inherits its parent's estimate rather than snapping back to the prior. That property is what decides whether the model is useful after 50 hands or only after 5,000.

Position is dropped first because it is the weakest signal per unit of sparsity — six values, and most of what position does is already visible through `facing`. Bucket is introduced late but never dropped from levels 2–5, because it is the axis being estimated; levels 0 and 1 carry no bucket at all, which is exactly what makes them writable from folded hands (§8).

### No double counting: inclusion and exclusion
The naive version of this chain feeds the same observation into all six levels, so 30 hands at one context would move the estimate as if there had been 180. Instead each level uses its **exclusive** evidence — the observations it saw that the finer levels did not — via inclusion–exclusion over the six cells:

Writing $n_\ell$ for a cell's raw total and $\tilde n_\ell$ for the exclusive evidence level $\ell$ actually uses:

$$
\begin{aligned}
\tilde n_{\text{global}} &= n_{\text{all}} - n_{\text{node}} - n_{\text{bucket}} + n_{\text{bsf}},\\
\tilde n_{\text{node}} &= n_{\text{node}} - n_{\text{bsf}},\\
\tilde n_{\text{bucket}} &= n_{\text{bucket}} - n_{\text{bs}},\\
\tilde n_{\text{bs}} &= n_{\text{bs}} - n_{\text{bsf}},\\
\tilde n_{\text{bsf}} &= n_{\text{bsf}} - n_{\text{full}},\\
\tilde n_{\text{full}} &= n_{\text{full}}.
\end{aligned}
$$

The coefficient columns sum to $(1,0,0,0,0,0)$, so summing the exclusive totals across levels returns exactly the global total: **every observation is counted once, at the most specific level that saw it**, and `likelihood.test.ts` asserts that partition directly. The identities that make it valid, for a fixed query context, are $\text{node} \cap \text{bucket} = \text{bsf}$ and $\text{full} \subset \text{bsf} \subset \text{bs} \subset \text{bucket}$, $\text{bsf} \subset \text{node}$ — so every exclusive count is non-negative by construction.

### The Beta posterior mean survives, as one node of the chain
The smoothing at each level is

$$
\widehat{\theta} = \frac{\text{count} + \delta\cdot m}{\text{total} + \delta},
$$

the posterior mean of a Dirichlet component whose prior mean is $m$ and whose prior strength is $\delta$ pseudo-observations. **This is the formula the previous edition of this document derived, unchanged.** Substituting $m = \alpha/\delta$ with the shipped constants $\alpha = \texttt{LEARNING\_PRIOR\_ALPHA} = 2$ and $\delta = \texttt{LEARNING\_PRIOR\_DENOM} = 10$ gives

$$
\widehat{\theta} = \frac{k + 2}{n + 10},
$$

exactly `bayesian.learnedLikelihood`, digit for digit — $10\times0.2$ is exactly $2.0$ in IEEE-754, so this is not an approximation but an identity, and `likelihood.test.ts` asserts it as one.

The interpretation is the textbook conjugate one and still applies. Treat "did the player take this action here?" as Bernoulli with rate $\theta$, place a $\text{Beta}(\alpha,\ \delta-\alpha) = \text{Beta}(2,8)$ prior on it, observe $n$ decisions of which $k$ took the action: the posterior is $\text{Beta}(k+2,\ n-k+8)$ with mean $(k+2)/(n+10)$. With no data every action starts at $2/10 = 0.20$; as $n\to\infty$ the estimate converges to the empirical frequency $k/n$, so the prior's influence vanishes with evidence.

Two things generalise, and only two:

- **The prior mean is supplied by a coarser estimate instead of being pinned at 0.20.** That single substitution is what turns one Beta update into a backoff hierarchy. Both limits survive verbatim: no data returns $m$, and $\text{total}\to\infty$ returns $\text{count}/\text{total}$.
- **Five actions, not two.** Because the five pseudo-counts sum to $5\times2 = 10 = \delta$ exactly, the shipped constants already *are* a symmetric $\text{Dirichlet}(2,2,2,2,2)$ — the multi-action generalisation of $\text{Beta}(2,8)$ — with no re-derivation needed.

Two prior ids exist purely to keep that continuity checkable rather than merely asserted. The `flat` id sets every action to exactly $\alpha/\delta = 0.20$, which is the no-data claim above made literally true of this module. The `legacy` id broadcasts the flat $3\times5$ table over buckets, and passing a fresh `legacy`-prior model through `collapsedLikelihoods` reproduces `ACTION_LIKELIHOODS` exactly — so the old model is demonstrably a *special case* of this one rather than something that was thrown away.

*(A note on why the legacy rows are deliberately left unnormalised: the old table is five independent per-hand Bernoullis, not a categorical, and its rows sum to about 1.75. That is harmless, because Bayes normalises over **hypotheses**, not over actions — scaling a likelihood column leaves the posterior untouched.)*

### Pooled evidence is discounted by $1/\text{BUCKET\_COUNT}$
Levels 0 and 1 carry no bucket, so a decision recorded there could have come from any of the nine buckets. As evidence about *one specific* bucket it is worth roughly $1/9$ of an attributed decision — the value of a uniform soft assignment. Weighting it that way is identical to making its prior strength nine times larger, which is all the constant is:

$$
\texttt{POOLED\_STRENGTH} = \texttt{PRIOR\_STRENGTH} \times \texttt{BUCKET\_COUNT} = 10 \times 9 = 90.
$$

Without it the pooled levels win on volume and **flatten the prior's bucket structure**: after 10 hands the model would have replaced "strong hands raise more" with "this player raises 20% of the time", which is a strictly worse estimate than the one it started from. With it, nine pooled observations move a bucket's estimate about as far as one attributed observation does.

### Inverting the model: from actions to a range
The likelihood model is read in both directions by the same code, which is what keeps the range the bot bets against and the range it prices folds against *the same range*. Run forwards, `foldByBucket` asks how often a bet gets through. Run backwards, `opponentRanges` asks what a seat's bets imply about what it holds (`src/poker/model/decider.ts`):

1. **Start from a flat prior.** Before anybody acts, every combo the deck still allows is equally likely — that is what "dealt at random" means. The familiar $0.40 / 0.35 / 0.25$ tilt toward strength is *not* a prior at all; it is the **posterior** after a seat has chosen to play, and deriving it rather than assuming it is what lets a limp and a three-bet disagree.
2. **Multiply.** For every action the seat took, multiply each combo by $\Pr(\text{action}\mid \text{bucket}(h),\ \text{street},\ \text{position},\ \text{facing})$, with the bucket measured against the board **as it stood on that street**. A flop bet is scored against the flop, not against the river the hand eventually ran out to — the actor could not see those cards, so weighting its range by what they made would be reading its mind rather than its bets.
3. **Renormalise after each factor**, so the range is a probability distribution at every step rather than only at the end.

Card removal is applied once up front and never undone: multiplying by a per-combo factor cannot resurrect a zero, so a combo the hero can see stays impossible however the seat bets. And because every likelihood is bounded below by the prior's uniform mixture, no product can reach zero, so the renormalisation can never divide by nothing.

This is where §4 pays off: on K-7-2 the combo 7-2 is two pair and gets the weight a bet deserves, where a preflop Chen score would have filed it under trash and folded it out of the continuing range.

---

## 8. Learning from a Real Opponent

### Purpose
The generated prior is a claim about poker players in general. The learned model is a claim about **one player**, and `src/lib/opponentMemory.ts` is the seam that turns finished hands into one.

### Scope, which is the whole design
A learned model describes the seat it was accumulated from and nobody else. Pointing it at every seat would be a category error — it would tell a bot that the seat across the table folds to river bets 71% of the time on the evidence of somebody else's folds. So the model is a function of the seat being read:

```ts
export type SeatModels = (seat: number) => LikelihoodModel;
export const defaultSeatModels: SeatModels = () => OPPONENT_MODEL;
export function modelForSeat(seat, model): SeatModels {
  return (id) => (id === seat ? model : OPPONENT_MODEL);
}
```

An empty memory is not merely *close* to the default, it **is** the default: $\text{betaMean}(0,0,m) = m$ exactly at every level of the backoff, so a model with no cells cannot move a single lookup, and the tests assert that a whole session plays out bit-identically through one.

### What a fold teaches, and what it does not
The previous model only learned at showdown, which throws away the large majority of decisions — most hands end in a fold, and a player who folds 80% of their big blind is telling you a great deal about themselves.

What a fold **does** teach is how often this player takes this action at this node. $\Pr(\text{fold}\mid \text{river},\ \text{facing-raise})$ is fully observable and is exactly the "fold to a river raise" statistic every tracker in the world reports; and therefore also this player's overall action mix, which is what levels 0 and 1 hold.

What a fold does **not** teach is $\Pr(\text{action}\mid\text{bucket})$. The cards were mucked. Any bucket assigned to that hand would be fabricated, and would then be laundered through the backoff into a number presented to the player as a fact about their own play. So an unattributed observation writes to the two bucket-free levels and stops.

That is not a consolation prize. Those levels are the shrinkage target for the bucket-conditioned ones, so unattributed data still moves every bucket's estimate — it moves them all *together*, compressing the likelihood ratio between buckets. Which is precisely correct: learning that a player raises constantly, without ever seeing what they raise with, should make a raise mean **less**, not make it mean "strong". That single mechanism is where the bluffer discount comes from, and it works before the first showdown.

**An honest caveat**, since this is shown to the player: attributed data is selection-biased. Hands survive to showdown disproportionately when they were strong enough to keep calling, so $\Pr(\text{action}\mid\text{bucket})$ estimated from showdowns over-represents hands that wanted to see the river. The bucket-free levels are not biased that way, which is a second reason to keep them in the chain.

### A hand does not have one hand class
`buckets.ts` classes are board-relative: the same two cards are Air on the flop and TwoPair by the river, and the model conditions on which. So a hand cannot be recorded under a single bucket, and each decision is instead bucketed against the board *as it stood on that street*, using the same `BOARD_CARDS_AT` slicing the decider reads it back with — imported rather than restated, because a decision *counted* under its river bucket and *looked up* under its flop bucket is a silent mismatch that no test of either side alone would catch.

The unit of observation moved with it. The showdown-only predecessor had to de-duplicate actions within a hand, because with no context every action landed in the same cell and a three-bet-then-call would double count. Here each decision carries its own (street, facing), so the decisions occupy different cells and each is a genuine independent draw from that node's categorical. The statistic changes from "hands in which the action occurred" to "decisions taken at this node" — the stronger of the two, and the one that makes a node's row sum to 1.

Recording is also de-duplicated by deal seed, because counts add and the same report reaches the module from two directions (the live hand-over effect, and the archive replayed on load).

### The measured result
`src/lib/opponentMemory.test.ts` plays 60 hands against a scripted bluffer — a seat with an obvious, exploitable leak — recording after every hand exactly the way the live table does, and then asks what the bots believe. Over those 60 hands the model saw 212 decisions (208 from hands shown at showdown, 4 mucked) across 239 non-empty cells, and:

| after | $\Pr(\text{bet}\mid\text{Air})$ | air share of the read | $\Pr(\text{weak}\mid\text{observed bet})$ |
|---|---|---|---|
| 0 hands (prior) | 0.136 | 34.0% | 0.198 |
| 5 | 0.168 | 43.9% | 0.221 |
| 10 | 0.392 | 61.6% | 0.309 |
| 20 | 0.407 | 72.1% | 0.375 |
| 40 | 0.433 | 84.0% | 0.545 |
| 60 | **0.553** | **88.7%** | **0.664** |

Three separate things moved, and they are three statements of one fact. The **likelihood** learned the leak: this player bets air four times more often than the prior expects anybody to. The **posterior after an observed bet** moved toward weak and past strong, which is the Bayesian statement of the same thing. And the **range the sampler actually draws from** — the thing that reaches an equity number and then an EV — went from a third air to nearly nine tenths.

The scoping claim is tested alongside it: a second seat that sat at the same table the whole time has a bit-identical read before and after.

---

## 9. Equilibrium: Discounted CFR

### Purpose, and why a solver at all
Everything above computes a **best response to a model**. That is the right thing for a bot playing a specific opponent, and it is exploitable by construction: a strategy tuned to a belief is beatable by anyone who knows the belief. The solver answers the complementary question — what would a strategy that *cannot* be exploited look like — and, more usefully here, it provides ground truth to check the rest of the engine against.

### Counterfactual regret, with a discount
`src/poker/solver/cfr.ts` implements **Discounted CFR** (Brown & Sandholm, *Solving Imperfect-Information Games via Discounted Regret Minimization*, AAAI 2019, arXiv:1809.04040). Every CFR variant carries the same worst-case $O(T^{-1/2})$ bound, so the choice between them is entirely empirical.

The paper's definition, verbatim: a family "defined by multiplying accumulated positive regrets by $t^\alpha/(t^\alpha+1)$, negative regrets by $t^\beta/(t^\beta+1)$, and contributions to the average strategy by $(t/(t+1))^\gamma$ on each iteration $t$." The recommended parameters are used here unchanged:

$$
\alpha = \tfrac32,\qquad \beta = 0,\qquad \gamma = 2.
$$

$\beta = 0$ gives $t^0/(t^0+1) = 1/2$: negative regret is **halved** every iteration rather than zeroed, which the paper prefers to $\text{DCFR}(3/2,-1,2)$ because zeroing "can produce a spike in exploitability that takes many iterations to recover from". The other named variants fall out of the same two limits, which is why they cost nothing to keep as controls: CFR+ is $\text{DCFR}(\infty,-\infty,2)$, Linear CFR is $\text{DCFR}(1,1,1)$, and vanilla CFR (Zinkevich 2007) is $\text{DCFR}(\infty,\infty,0)$.

The discount is applied *after* iteration $t$'s contribution is added, which is what makes the paper's own equivalences hold: multiplying by $t'/(t'+1)$ for every $t' \in [t,T]$ leaves iteration $t$ weighted $t/(T+1)$, i.e. linearly.

Two structural points matter mathematically rather than mechanically.

**It is the average strategy that converges**, not the current regret-matching one. `averageStrategy()` normalizes the accumulated $\sum_t \pi^t(h)\,\sigma^t$; `currentStrategy()` exists only for inspection.

**Updates alternate.** The paper notes that "in practice far better performance is achieved by alternating which player updates their regrets on each iteration", and player 1's traversal here already sees player 0's freshly updated regrets.

Regret matching itself is the standard rule: probabilities proportional to positive regret, uniform where every action's regret is non-positive.

### Exploitability is the proof, and it is exact
A CFR implementation with a sign error still produces strategies that *look* like poker — it bets strong hands and folds weak ones — because those are forced by the payoffs, not by the equilibrium. What a broken solver cannot do is drive exploitability down.

$$
\text{exploitability}(\sigma) = \frac{\text{BR}_0(\sigma_1) + \text{BR}_1(\sigma_0)}{2},
$$

reported in **mbb/h**, thousandths of a big blind per hand. With payoffs shifted so the game value is zero, exploitability is just the average best-response value: zero exactly at equilibrium and never negative in a zero-sum game. The best response is computed **exactly**, not by another CFR run — an infoset here is exactly (public node, own hand), so best-responding is a per-hand max over actions while the opponent's reach propagates down the tree (`src/poker/solver/exploitability.ts`).

One subtlety in the normalization: the root value is counterfactual, weighted by the villain's prior, which does not sum to 1 per hero hand once card removal bites. Dividing by the total compatible mass turns it into chips per hand *actually dealt*.

### Validation I: a game with a closed-form answer
Kuhn poker is a three-card, one-street game whose equilibrium is known analytically. `src/poker/solver/cfr.test.ts` recovers all of it:

- The **game value $-1/18$ to player 1**, pinned from both sides — at equilibrium each best-response value equals the game value from that side — to three decimal places.
- Exploitability below $10^{-4}$ after 20,000 iterations.
- The **$\alpha$-family** structure: player 1 bets the king exactly three times as often as the jack, with $\alpha = \Pr(\text{bet jack}) \in [0, 1/3]$, and never bets the queen out of position.
- Player 2's fully determined strategy: bet the jack $1/3$ when checked to, always bet the king, and facing a bet fold the jack, call the queen $1/3$, call the king.
- Player 1's closed-form calling frequency $\alpha + 1/3$ with the queen.

Nothing poker-specific is involved, so this isolates the solver core from the poker code entirely.

### Validation II: published Nash charts
`src/poker/solver/pushfold.ts` solves heads-up preflop push/fold — the small blind may only shove or fold, the big blind only call or fold — which is the one poker game here whose equilibrium has been published and independently recomputed many times.

Two modelling choices, both forced. The game is solved over the **169 chart classes**, not the 1326 combos: preflop the whole game is invariant under permuting suits, so equilibrium frequencies are constant within a class and solving at the combo level would multiply the work by 60 for the same numbers. Card removal is *not* dropped along with the combos — `classCompatibility` keeps the exact fraction of disjoint combo pairs per class pair, counted in closed form because the only combo of $Y$ holding both of a given combo's cards is that combo itself:

$$
\text{pairs}(X,Y) = |X||Y| - \sum_{h \in X}\big(c_Y(h_1) + c_Y(h_2)\big) + |X|\,\mathbb{1}[X=Y].
$$

And preflop all-in equity is **estimated**, not enumerated: an exact $169\times169$ matrix means $\binom{48}{5} = 1.7$M runouts for each of ~14k class matchups. Instead every matchup is scored on the *same* sampled boards — common random numbers — which makes the differences between neighbouring hands, the only thing a push/fold threshold depends on, far more accurate than the absolute equities.

One detail there is a genuine sampling trap and is worth stating. Dealing the board **first** and the hands second is not the same experiment as dealing the hands first. A board with a king on it leaves KK only three combos instead of six, so under uniform board sampling every surviving KK combo stands in for half as many real deals as it should: king-high boards get double weight, and AA vs KK comes out at 74.5% instead of 82%. Each sample is therefore weighted by $n_X n_Y$, the number of live combos the board left the two classes, which is exactly the factor that restores a uniform distribution over (hand, hand, board) triples. Checked against an exhaustive $\binom{48}{5}$ enumeration of that matchup, the corrected estimate lands at 81.818% against an exact 81.946% — an error of $-0.128$ percentage points. (The exact value depends on suit overlap: 82.64 / 81.95 / 81.26% at 2 / 1 / 0 shared suits, weighted 1 : 4 : 1.)

The results, at 24,000 sampled boards and 1,500 iterations:

- **Exploitability** of $1.4\times10^{-6}$, $3.5\times10^{-5}$ and $1.9\times10^{-5}$ mbb/h at 10, 15 and 20bb. The convergence curve runs $5.0\times10^{2}$ mbb/h at 1 iteration down to $6.6\times10^{-6}$ at 1,000.
- **Range widths** within half a point of the published tables: at 10bb the solver shoves 57.77% against a published 58.37% and calls 37.25% against 37.25%; at 15bb 46.04 / 45.70 and 27.84 / 28.81; at 20bb 39.05 / 40.27 and 21.68 / 21.72.
- **Cell by cell, 1005 of 1014 = 99.11% agreement** ($169 \times 2$ tables $\times$ 3 depths). Two of the three call tables are exact — 169/169 at 10bb and at 20bb — and the third misses one cell (QTo at 15bb).

The nine disagreements are not places where the solver has a different opinion. Every one is within **2.5bb** of the chart's own published threshold, so nothing disagrees in the interior of a range; and re-solving on a different equity seed flips a comparable set of cells, which is the honest reading: they are hands whose published threshold sits inside the Monte Carlo error of the stack depth being tested.

### The river subgame
The same core solves a full river betting tree over two arbitrary ranges (`buildRiverGame`). The representation is a **public** tree — the betting sequence — with every node holding a whole vector of private hands at once. That is what makes it tractable: the public tree has a few dozen nodes, and a node's work is a handful of passes over a `Float64Array` of hands rather than a walk over $|\text{hands}|^2$ histories. The only place the two players' hands meet is at a terminal.

The showdown terminal is where the interesting trick lives. Both hand vectors are sorted by strength, so "how much villain reach do I beat" is a **prefix sum** rather than a pairwise scan, and the blocked part of it is the same running sum restricted to villain hands holding one of hero's two cards — 52 more accumulators. A villain hand holding *both* of hero's cards is hero's own combo, which ties rather than losing, so it is never in either running sum and the two card corrections cannot double-count. That single observation is why a terminal costs $O(n)$ and not $O(n^2)$.

Payoffs are shifted so the game is zero-sum: the pot both players brought into the river is dead money split evenly in the baseline, so winning it is worth $\text{pot}/2$ rather than $\text{pot}$. Nothing about the strategies changes — it is a constant shift — but exploitability is only meaningful as a sum of two best-response values when those values sum to zero at equilibrium.

Measured on a 57-node tree (bets of $\tfrac13$, $\tfrac23$, pot, plus all-in; one raise size; three aggressive actions max) with 165×107 hands, 400 iterations take 125 ms and reach 14.0 mbb/h. The convergence curve is the deliverable, and it descends cleanly:

| iterations | 10 | 25 | 50 | 100 | 200 | 400 | 800 |
|---|---|---|---|---|---|---|---|
| mbb/h | 11971 | 1728 | 535 | 178 | 51 | 14 | 4 |

The worst case the sampler can hand it — 1081×1081 hands, i.e. both players holding every combo the board leaves — costs 2.14 ms per iteration.

Abstraction size is visible in the same units, which is the honest way to price it: an all-in-only tree (9 nodes) reaches 1.8 mbb/h, pot-plus-all-in with one raise (21 nodes) reaches 5.7, and the default 57-node tree reaches 13.3. A coarser abstraction is *less exploitable within its own game* and says less about the real one — the number to read is not "how low did it go" but "how low, on how large a tree".

### Which variant, measured
The paper's claim is that the discount schedule matters in practice even though the worst-case bound does not change. On the river tree above, at **200 iterations**:

| | DCFR(3/2, 0, 2) | CFR+ | Linear CFR | vanilla CFR |
|---|---|---|---|---|
| exploitability (mbb/h) | **31.9** | 60.8 | 153.5 | 856.1 |

DCFR is roughly twice CFR+ and 27 times vanilla — consistent with the paper's own "matches or outperforms CFR+ across the board… usually a factor of 2 or 3". In a browser that is the difference between a solve and a hang, which is why DCFR is the default and vanilla exists only as a convergence-rate control.

---

## 10. Reproducibility and Precision

### One number replays a hand
Every draw comes from an explicit `Rng` (**xoshiro128\*\*, seeded through SplitMix32**) rather than the ambient `Math.random`, and there is no module-level generator state, so each worker owns its own stream without coordinating (`src/poker/core/rng.ts`).

Seeds are **derived, not stored**, which is what makes any part of a session reconstructible from a single number:

$$
\text{seed}_{\text{hand}} = H(\text{seed}_{\text{session}},\, n_{\text{hand}}),
\qquad
\text{seed}_{\text{decision}} = H(\text{seed}_{\text{session}},\, n_{\text{hand}},\, n_{\text{action}},\, \text{seat}).
$$

Keying a decision by its **index within the hand** rather than by a running counter is deliberate: one decision can be re-run in isolation — for a replay, or for a test — without depending on how much entropy the decisions before it happened to consume.

Two details are probabilistic rather than engineering:

- **Seeding.** xoshiro's state must not be all-zero and mixes slowly out of a low-entropy start, so the seed is expanded through SplitMix32. Advancing the Weyl counter *before* mixing means seed 0 still yields four distinct, well-spread words, and since `mix32` is injective at most one of them can be zero.
- **Uniform integers.** `int(n)` rejects the ragged tail of the 32-bit range so the surviving values are an exact multiple of $n$, then takes the remainder. `Math.floor(next() * n)` would be very slightly biased when $n$ does not divide $2^{32}$, and would launder the draw through a 53-bit float.

### The same numbers on every machine
Three separate mechanisms hold this:

1. The shard count is a **constant** (`SHARDS = 4`), not a function of `navigator.hardwareConcurrency`. Cores decide only *which* shard runs where.
2. Shard results are merged by **integer addition in shard order**, never completion order, and normalized exactly once at the end.
3. The worker path and the in-process fallback go through the same `runShard` and the same encode step, so they are identical by construction rather than by keeping two copies in step.

The engine tests assert this directly: 40 hands replayed from the same seed serialise to the same JSON, and 20 hands from a different seed do not.

---

## 11. Reading the Bot's Mind

### Purpose
Every decision the bot makes is auditable: the inputs, the price of every candidate, the derivation of each price, and the chosen action — so a reviewer can verify the $\arg\max$ by hand.

### What is stored per decision
```ts
return {
  seat, street,
  action: choice.action,
  potBefore, toCall,
  equity,                    // MultiwayEquity: equity, pWin, per-opponent, CI
  evByAction: evs,           // every candidate, including sizes not chosen
  beliefs: readsFromActions(...),
  profile: profile.id,
  foldEquity: priced?.byLabel,   // the full FoldEquityBreakdown per size
  equityVsRange: priced?.eRange,
};
```

Two of these deserve comment. `evByAction` is keyed by **label**, so each rung of the sizing ladder appears as its own candidate and the $\arg\max$ over sizes is visible, not just the $\arg\max$ over action types. And `foldEquity` carries a whole `FoldEquityBreakdown` per size — $\Pr(\text{fold})$ overall and per opponent, $E_{\text{cont}}$, mean callers, mean pot if called, the fold term and the call term separately — so the derivation in §6 can be displayed rather than asserted. Every field is either an input or a mean over the run, and `ev` is reconstructible from them.

The records are copied into an immutable report at hand end, and the review page reads them back with **no recomputation**. The displayed numbers are literally the ones used to decide, which is what makes this an audit rather than a reconstruction.

### What a decision cost: two numbers that must never be merged
The coach layer scores every action a seat took against the alternatives it could have taken instead, and reports the result **twice** (`src/poker/coach/evLoss.ts`). The distinction is the pedagogical core of the whole review, and it is a statement about conditioning:

$$
\text{modelEv} = \mathbb{E}\big[\text{chips} \mid \mathcal{F}_{\text{public}}\big],
\qquad
\text{hindsightEv} = \mathbb{E}\big[\text{chips} \mid \mathcal{F}_{\text{public}},\ \text{all hole cards},\ \text{the board that came}\big].
$$

`modelEv` is priced against the range inferred from the public action so far — nothing but what the seat could have known at the moment it acted — and it is the only number a decision should be judged by. `hindsightEv` is omniscient and therefore results-oriented: a correct call that got outdrawn shows a loss, and a reckless call that spiked shows a gain. Its long-run average over correct decisions is **zero by construction**, which is exactly why it is worth showing *next to* the model number rather than instead of it: the gap between the two can then be named out loud as variance rather than mistaken for skill.

The sign convention makes the loss un-gameable:

$$
\text{evLoss} = \text{ev}(\text{chosen}) - \max_{a}\text{ev}(a) \;\le\; 0,
$$

exactly zero iff the best action was taken, and never positive because the chosen action is always a member of the set the maximum is taken over.

Two scope limits are stated rather than hidden. This compares **action classes**, not bet sizes: in a model with no fold-equity term the opponent is assumed to call, so $\partial\text{EV}/\partial\text{cost} = 2e - 1$ and any holding above 50% equity would be told to jam every time. A sizing critique from that model would be noise dressed up as advice, so the aggressive alternative is priced at exactly one canonical size (the ½-pot rung) and the seat's own size is used whenever the seat itself bet or raised. And because the report carries no stacks, the module cannot tell a seat that *chose* to call from one that was all-in with no raise available — so `alternatives` lists exactly what was considered, and a counterfactual is visible rather than assumed away.

Because it rebuilds the read itself from the public record, this works identically for a **human** seat — which has no `BotDecision` and recorded no equity of its own — and for a bot.

### Tracing one decision
A four-handed flop, hero on the button with a bare flush draw, pot \$60, one opponent has bet \$20, one has folded, one is yet to act.

1. **Ranges.** `opponentRanges` starts each live opponent at a flat range over the 1326 combos, zeroes every combo containing a hero or board card, and multiplies by $\Pr(\text{action}\mid\text{bucket},\dots)$ for each action on the record — the preflop actions bucketed against an empty board, the flop bet against the three flop cards (§7).
2. **Showdown equity.** `decisionSims` gives $\max(5000,\ 20000/2) = 10{,}000$ simulations of the whole field, drawn as one tuple from those ranges (§5). Suppose it returns $\text{equity} = 0.31$ with $\Pr(\text{win}) = 0.30$ — the gap is chops the hero collects a share of.
3. **The baseline prices.** `evInput` substitutes $0.31$ for `pWin`, and `actionEv` gives $\mathbb{E}[\text{Fold}] = 0$ and, for the call, $0.31\times60 - 0.69\times20 = 18.6 - 13.8 = +\$4.8$.
4. **The call is re-priced**, because a seat behind still owes chips, so `closesAction` is false. `callEv` simulates the field that actually shows up at the price each seat is offered and returns the mean per-simulation payoff — a different, and comparable, number.
5. **Every raise size is priced with fold equity.** For each rung of the ladder, the continuing range is derived at that size's $\Pr(\text{fold})$, 800 simulations are run against it under a shared seed, and $\Pr(\text{fold})\cdot P + (1-\Pr(\text{fold}))\cdot\mathbb{E}[\dots]$ is the price. A bare flush draw is exactly the hand for which this can beat checking: its showdown value is poor, but the folds it buys are real.
6. **argmax**, then the profile. All prices are on one basis, so the comparison means something; the seat's personality may still substitute a different legal move, and the record shows both.

---

## 12. Probability Concepts Demonstrated

**Conditional probability.** $\Pr(A\mid B)=\Pr(A\cap B)/\Pr(B)$. The likelihood model is a table of conditionals $\Pr(\text{action}\mid\text{bucket},\text{street},\text{position},\text{facing})$ (§7); the continuing range is the conditional $R(h\mid \text{did not fold})$ (§6); card removal is conditioning on the visible cards, implemented as an assignment (§3).

**Bayesian inference.** Posterior $\propto$ likelihood $\times$ prior. `updateBelief` is a literal implementation over three tiers (§7); `opponentRanges` is the same rule over 1326 hypotheses, applied once per observed action; the cross-hand learning is a conjugate Beta–Bernoulli (Dirichlet–categorical) update whose posterior mean supplies the likelihoods (§8).

**Hierarchical / shrinkage estimation.** Six nested estimates with each level's answer as the next level's prior mean, exclusive evidence apportioned by inclusion–exclusion, and pooled evidence discounted by $1/\text{BUCKET\_COUNT}$ (§7). The Beta posterior mean is the single-level case.

**Monte Carlo methods.** Estimate $\mathbb{E}[f(X)] \approx \frac1N\sum f(X_s)$ with error $O(1/\sqrt N)$ (§5). Unbiasedness, $\operatorname{Var} = p(1-p)/N$, and the choice of $N$ by whether the error can reorder an $\arg\max$ rather than by the error itself.

**Rejection sampling and exchangeability.** Whole-tuple rejection samples $\prod_i p(h_i)$ conditioned on disjointness, which is symmetric under permuting the seats; per-seat rejection is not, and the asymmetry was measured at up to 27 SE (§5).

**Importance sampling and the alias method.** Opponent hands are drawn from a belief- or evidence-weighted proposal rather than uniformly, in $O(1)$ per draw after an $O(1326)$ build (§3).

**Interval estimation.** Wilson score vs Wald, and why the Wald interval fails exactly where poker lives (§5).

**Martingales and the tower property.** Equity is a martingale in the information filtration; each street is an unbiased refinement of the last, with variance falling to zero by the river (§5).

**Expectation of a product.** $\mathbb{E}[XY] \ne \mathbb{E}[X]\mathbb{E}[Y]$ under correlation, with the sign of the error determined by the sign of the correlation, worth 24.58 chips and a flipped decision in the fixture that pins it (§6).

**Optimal transport.** Earth Mover's Distance between hand-strength distributions, in closed form on a line as the $L_1$ distance between CDFs, used to audit a taxonomy against published values (§4).

**Inclusion–exclusion.** Three separate uses: apportioning backoff evidence (§7), counting disjoint combo pairs between chart classes in closed form (§9), and correcting the card-blocked reach in the river showdown sweep (§9).

**Game theory and regret minimisation.** Counterfactual regret with a discount schedule; the average strategy converges, not the current one; exploitability as an exact best-response value and the only honest test of a solver (§9).

**Conditioning sets, and why two expectations of the same quantity disagree.** Model EV conditions on the public record; hindsight EV conditions on everything. The second has mean zero over correct decisions, so the gap between them is variance and not skill — which is why the review never merges, averages, or co-locates them (§11).

**Decision making under uncertainty.** The full pipeline — public record $\to$ range per opponent $\to$ multiway equity $\to$ EV of every action and size, with fold equity $\to$ $\arg\max$. The bot never observes anyone's cards yet acts optimally with respect to its current model, and that model improves as uncertainty about a specific opponent is reduced through observed play.

---

## Appendix: key constants (single reference)

| Quantity | Symbol / name | Value | Source |
|---|---|---|---|
| Deck size | $\|D\|$ | 52 | `poker/cards.ts` |
| Hole-card combinations | $\binom{52}{2}$ | 1326 | `COMBO_COUNT`, `model/range.ts` |
| Chart classes | — | 169 | `GRID_CELLS`, `model/range.ts` |
| Hand classes | `BUCKET_COUNT` | 9 | `model/buckets.ts` |
| Table sizes | — | 2–6 seats | `MIN_SEATS`/`MAX_SEATS`, `table/position.ts` |
| Default table | — | 4 seats, 100bb, \$5/\$10 | `DEFAULT_SETUP`, `lib/tableOptions.ts` |
| Sizing ladder | — | ⅓, ½, ¾, pot, all-in | `LADDER`, `table/rules.ts` |
| Table decision sims | — | 20000 / 20000 / 15000 / 10000, ÷ opponents | `TABLE_DECISION_SIMS`, `model/decider.ts` |
| Sim floor | `MIN_DECISION_SIMS` | 5000 | `model/decider.ts` |
| Fold-equity sims | `FOLD_EQUITY_SIMS` | 800 | `model/decider.ts` |
| EV-loss model sims | `DEFAULT_MODEL_SIMS` | 2000 | `coach/evLoss.ts` |
| Monte Carlo shards | `SHARDS` | 4 (constant, not core count) | `equity/pool.ts` |
| Tuple redraw bound | `MAX_TUPLE_ATTEMPTS` | 256 | `equity/multiway.ts` |
| Confidence interval | 95% | Wilson score, $z = 1.959964$ | `core/stats.ts` |
| Preflop tier prior | $\Pr(H)$ | (0.40, 0.35, 0.25) | `INITIAL_BELIEF`, `data/constants.ts` |
| Default raise likelihood | $\Pr(\text{raise}\mid H)$ | (0.05, 0.25, 0.70) | `ACTION_LIKELIHOODS` |
| Dirichlet prior | $(\alpha,\delta)$ | (2, 10) → 0.20 each | `LEARNING_PRIOR_*` |
| Pooled prior strength | `POOLED_STRENGTH` | $10\times9 = 90$ | `model/likelihood.ts` |
| Backoff levels | — | 6 | `LEVEL_NAMES`, `model/likelihood.ts` |
| Likelihood cells | — | $9\times4\times6\times3 = 648$ | `model/likelihood.ts` |
| Prior uniform mix | `PRIOR_MIX` | 0.08 (Bayes factor $\le$ ~30) | `model/likelihood.ts` |
| MDF fold cap | `MDF_FOLD_SCALE` | 0.47 | `model/likelihood.ts` |
| Sizing reference | `REFERENCE_FRACTION` | 0.5 pot, sensitivity 1, capped at pot | `model/decider.ts` |
| Equity bins | `DIST_BINS` | 50 (bin width 0.02) | `model/distribution.ts` |
| DCFR parameters | $(\alpha,\beta,\gamma)$ | $(3/2,\ 0,\ 2)$ | `DCFR`, `solver/cfr.ts` |
| Push/fold boards | — | 24,000 | `solver/pushfold.ts` |
| EV of an action | — | $p(P+\text{extra})-q\,\text{cost}$ | `actionEv`, `ev.ts` |
| EV of a bet | — | $\Pr(\text{fold})P + (1-\Pr(\text{fold}))[E_{\text{cont}}(P+2s)-s]$ | `foldEquityEv`, `ev.ts` |
| Break-even bluff | $\alpha$ | $s/(P+s)$, $\text{MDF}=1-\alpha$ | `ev.ts`, `ev.test.ts` |

Every figure in this document is computed by the code at the cited locations or asserted by its tests; none are hardcoded outcomes.
