# The Probability Behind Probability Poker

This project is a heads-up Texas Hold'em game where I play against a bot that I built to make every decision using probability theory rather than hand-coded poker rules. I wanted the bot to actually *reason* under uncertainty: estimate its chances of winning, update beliefs about my hand as I act, learn my tendencies over time, and choose actions that maximize expected payoff. This writeup explains the four mathematical ideas that make that work. Monte Carlo simulation, Bayesian updating, a learned opponent model, and expected value, and how they fit together.

Throughout, I write $\Pr(\cdot)$ for probability and $\mathbb{E}[\cdot]$ for expectation. The "hero" is whoever's perspective a calculation takes (usually the bot).

## 1. Monte Carlo Simulation: estimating equity

The central quantity the bot needs is its **equity**, the probability it wins the hand. In principle this is just a big finite average over every way the hidden cards could come out, but that space is enormous. Before the flop the opponent could hold any of $\binom{50}{2} = 1225$ two-card hands, and for each of those the five board cards can fall $\binom{48}{5} = 1{,}712{,}304$ ways, which is around $2 \times 10^9$ joint outcomes. Computing the exact average on every turn is hopeless, so instead I estimate it.

The idea is the law of large numbers. If I want $p = \Pr(\text{win})$, I run $N$ independent simulated showdowns. In simulation $s$ I deal random cards into all the unknown slots (the opponent's hole cards and the undealt board), score both five-card hands, and record the indicator

$$
X_s = \mathbb{1}[\text{hero's best hand beats opponent's}].
$$

The $X_s$ are i.i.d. Bernoulli($p$), so the sample mean is my estimate:

$$
\hat{p} = \frac{1}{N}\sum_{s=1}^{N} X_s = \frac{\text{Wins}}{N}, \qquad
\hat{q} = \frac{\text{Losses}}{N}, \qquad
\widehat{\Pr}(\text{tie}) = \frac{\text{Ties}}{N}.
$$

This estimator is unbiased, $\mathbb{E}[\hat{p}] = p$, with variance $\operatorname{Var}(\hat{p}) = p(1-p)/N$. The standard error is therefore

$$
\mathrm{SE}(\hat{p}) = \sqrt{\frac{p(1-p)}{N}} \le \frac{1}{2\sqrt{N}},
$$

which is the key fact: the error shrinks like $1/\sqrt{N}$ regardless of how complicated the outcome space is. That $O(1/\sqrt N)$ behavior is exactly why Monte Carlo beats enumeration here. I use more samples early in the hand (around $7000$ before the flop) and fewer later (around $3000$ on the river), because once most of the board is known there is less randomness left and the same accuracy needs fewer trials. At $N = 5000$, for example, the error bound is about $\pm 1.4$ percentage points.

One subtlety: I do **not** sample the opponent's hand uniformly. I sample it from what I currently believe about their strength (Section 2), which makes this an importance-sampling-style estimate where the proposal distribution is my belief rather than the uniform deal. That is the bridge between the simulation and the Bayesian part.

## 2. Bayesian Updating: reading the opponent's hand

The bot can't see my cards, so it keeps a probability distribution over how strong my hand is, bucketed into three hypotheses $H \in \{\text{weak}, \text{medium}, \text{strong}\}$. Every time I take an action $A$ (check, call, bet, raise, fold), it revises that distribution with Bayes' rule.

It starts from a **prior** $\Pr(H)$, my preflop belief that a random starting hand is $(\text{weak}, \text{medium}, \text{strong}) = (0.40, 0.35, 0.25)$. It also has a **likelihood** table $\Pr(A \mid H)$, the probability of each action given each strength. These encode poker intuition: a raise is much more likely from a strong hand than a weak one. The default raise row, for instance, is $\Pr(\text{raise} \mid H) = (0.05, 0.25, 0.70)$.

When I act, the bot computes the **posterior** by Bayes' theorem:

$$
\Pr(H \mid A) = \frac{\Pr(A \mid H)\,\Pr(H)}{\Pr(A)}
= \frac{\Pr(A \mid H)\,\Pr(H)}{\sum_{H'} \Pr(A \mid H')\,\Pr(H')}.
$$

The denominator is the total-probability normalizer (the "evidence"). Concretely, suppose I raise from the starting prior. The unnormalized numerators $\Pr(A\mid H)\Pr(H)$ are

$$
\text{weak}: 0.05 \times 0.40 = 0.0200, \quad
\text{medium}: 0.25 \times 0.35 = 0.0875, \quad
\text{strong}: 0.70 \times 0.25 = 0.1750,
$$

summing to $\Pr(\text{raise}) = 0.2825$. Dividing gives the posterior

$$
\Pr(H \mid \text{raise}) \approx (0.071,\ 0.310,\ 0.620).
$$

So one raise pushes the bot's belief that I'm strong from $25\%$ up to about $62\%$, and collapses "weak" from $40\%$ to $7\%$. Each action's posterior becomes the prior for my next action, so the belief is a running product of likelihoods, a discrete Bayes filter that gets sharper as the hand goes on. This updated belief is exactly what re-weights the Monte Carlo hand sampling in Section 1, so a read that I'm strong lowers the bot's estimated equity.

## 3. Learned Opponent Modeling: adapting across hands

The likelihood table above is a fixed guess about how a *generic* player behaves. The more interesting part is that the bot **learns** my personal likelihoods from data. Whenever a hand reaches showdown my cards are revealed, so the bot can classify my true strength tier and record which actions I actually took with that tier. Over many hands it builds up counts: for each tier it tracks $n_T$, the number of revealed hands of that tier, and $k_{a,T}$, how many of those hands involved action $a$.

I could just use the raw frequency $k_{a,T}/n_T$ as the likelihood, but that is terrible with little data, one observed hand would slam an estimate to $0$ or $1$. So I smooth with a **Beta prior**. Treating "did the player take action $a$ in a hand of tier $T$?" as a Bernoulli with rate $\theta$, I put a $\text{Beta}(\alpha, \beta)$ prior on $\theta$ with $\alpha = 2$ and $\alpha + \beta = 10$. Because the Beta is conjugate to the Bernoulli, after $n_T$ observations with $k_{a,T}$ successes the posterior is $\text{Beta}(k_{a,T} + 2,\ n_T - k_{a,T} + 8)$, whose mean is the likelihood I actually use:

$$
\Pr(a \mid T) = \frac{k_{a,T} + \alpha}{n_T + (\alpha + \beta)} = \frac{k_{a,T} + 2}{n_T + 10}.
$$

This interpolates nicely between prior and data. With no observations ($n_T = k_{a,T} = 0$) every action sits at $2/10 = 0.20$, a neutral starting belief; as $n_T \to \infty$ the estimate converges to the empirical frequency $k_{a,T}/n_T$, so the prior washes out exactly when I have enough evidence to trust the data.

The payoff is genuine adaptation. Say I keep showing up with weak hands that I raised. After $15$ such showdowns,

$$
\Pr(\text{raise} \mid \text{weak}) = \frac{15 + 2}{15 + 10} = \frac{17}{25} = 0.68,
$$

far above the $0.20$ default. Now when I raise, the Bayesian update of Section 2 produces $\Pr(\text{weak} \mid \text{raise}) \approx 0.64$ instead of the $\approx 0.07$ it would have gotten from the generic table. The bot has learned that *I* raise light and reinterprets the identical action accordingly. So there are really two timescales of inference: a fast belief update within a hand, and a slow likelihood update across hands that feeds back into it.

## 4. Expected Value: turning probabilities into decisions

Knowing the win probability isn't enough to decide, a $30\%$ call can be correct if the pot is big, and an $80\%$ call can be a mistake if the price is wrong. So the bot chooses by **expected value**, the average chip outcome of an action:

$$
\mathbb{E}[O] = \sum_i o_i \, \Pr(o_i).
$$

I use a forward-looking, pot-odds version: chips already in the pot are sunk and ignored, and only what I risk *now* versus what I can win matters. With win probability $p$, loss probability $q$, current pot $P$, chips to call $c_{\text{call}}$, and an action that costs `cost` (where `extra` $= \max(0,\ \text{cost} - c_{\text{call}})$ is anything beyond a call), the general formula is

$$
\mathbb{E}[\text{action}] = p\,(P + \text{extra}) - q\,\cdot\text{cost},
$$

with ties treated as chip-neutral. The specific cases:

$$
\mathbb{E}[\text{Fold}] = 0, \qquad
\mathbb{E}[\text{Check}] = p\,P, \qquad
\mathbb{E}[\text{Call}] = p\,P - q\,c_{\text{call}},
$$

$$
\mathbb{E}[\text{Bet}] = p\,(P + \text{cost}) - q\,\cdot\text{cost}, \qquad
\mathbb{E}[\text{Raise}] = p\,(P + \text{extra}) - q\,\cdot\text{cost}.
$$

Folding is the zero baseline, which is what makes folding ever correct: any action is only worth taking if its EV beats $0$. Notice that setting $\mathbb{E}[\text{Call}] > 0$ recovers the classic pot-odds condition $p/q > c_{\text{call}}/P$, which is a nice sanity check that the formula matches poker theory.

The bot then simply plays the action with the highest expected value:

$$
a^\star = \arg\max_{a} \mathbb{E}[a].
$$

Because the $p$ and $q$ in these formulas come from the belief-weighted Monte Carlo, every layer feeds the next: learned likelihoods shape the Bayesian belief, the belief shapes the simulated equity, and the equity drives the expected value that picks the move.

## Putting it together

The whole bot is one pipeline of probability ideas: a prior over my hand, Bayesian updates from my actions using likelihoods that are themselves learned from past showdowns, Monte Carlo estimation of equity under that belief, and an expected-value argmax to act. It demonstrates conditional probability, Bayesian inference, conjugate priors, Monte Carlo estimation and its $1/\sqrt N$ error, and decision-making under uncertainty, all in service of a bot that plays better the more it watches me play.
