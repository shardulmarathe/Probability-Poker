/**
 * The concepts surface: the probability, without a hand attached.
 *
 * The hand review answers "what happened in that hand". This page answers "what
 * is this number, and why is it that number", over the same seven ideas the
 * engine is built out of, each one demonstrated by running the engine in the
 * browser on cards the page names out loud.
 *
 * Two rules it shares with the review, and they are the reason it is a page
 * rather than a document:
 *
 *   - Nothing is illustrated with a figure somebody typed in. Every
 *     probability, interval, class and exploitability is computed when the
 *     concept renders, or when the reader presses the button that runs it.
 *     Where an example needs specific cards, the cards are the example and the
 *     numbers are the engine's.
 *   - The vocabulary is the review's vocabulary: the same `HowCalculated`
 *     folds, the same `Calc` blocks, the same fractions, so a student who
 *     learns the idea here recognises it the moment it appears next to their
 *     own hand.
 *
 * One concept is mounted at a time. Seven interactive explanations stacked end
 * to end read as a textbook chapter rather than as seven explanations, and a
 * reader who came to understand pot odds would have to scroll past a Monte
 * Carlo convergence table and a 540-cell likelihood prior to reach it. Mounting
 * one at a time is also what keeps the page cheap: four convergence runs, a
 * generated likelihood model, a six-thousand-trial multiway sample and a river
 * solve would otherwise all be triggered by a single navigation to `/learn`.
 *
 * The selection lives in the query string rather than in `useState`, so
 * `/learn?c=bayes` opens on Bayes and the concept a reader is looking at is
 * something they can send to somebody. It is deliberately not a route: `/learn`
 * is one entry in the router and one in `vercel.json`, and a path per concept
 * would be seven more rows in a table that must stay in step with the router
 * (see `src/routes.test.ts`).
 */

import { useLocation, useSearchParams } from "react-router-dom";
import { PageBody, PageHeader } from "../shell";
import { Reveal, Tabs } from "../ui";
import { CONCEPTS, type ConceptId } from "./concepts";

export default function LearnPage() {
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();

  // Derived, not mirrored. A `useState` seeded from the query string is two
  // sources of truth that disagree the first time somebody presses Back, and an
  // unknown `?c=` value falls through to the first concept rather than rendering
  // an empty page.
  //
  // The hash is read as a fallback because this page was once seven in-page `#`
  // anchors, which are exactly the links a reader may have bookmarked or shared.
  // Ignoring one does not 404; it silently serves Monte Carlo to somebody who
  // asked for Bayes. The concept ids match those anchor names for this reason.
  const requested = params.get("c") || hash.replace(/^#/, "");
  const active = CONCEPTS.find((c) => c.id === requested) ?? CONCEPTS[0];

  const select = (id: ConceptId) => {
    const next = new URLSearchParams(params);
    // The default concept carries no parameter, so the canonical `/learn` and
    // the URL you get by clicking back to Monte Carlo are the same string.
    if (id === CONCEPTS[0].id) next.delete("c");
    else next.set("c", id);
    // `replace`, because a tab is a view of one page, not a place. Without it,
    // reading all seven concepts buries the page the reader arrived from under
    // seven history entries.
    setParams(next, { replace: true });
  };

  const Panel = active.Panel;

  return (
    <main
      className="relative min-h-[100svh] overflow-x-hidden text-ivory"
      data-testid="learn"
    >
      <PageBody width="narrow">
        <PageHeader
          title="The maths, on its own"
          lede="Seven ideas this product is built out of, one at a time, each one run here rather than described."
        />

        {/*
         * `layout="scroll"`, because seven labels never fit a 390px row and a
         * "fill" row would compress "EV, pot odds, fold equity" to an ellipsis.
         * No `showHint`: each concept prints its own one-line lede as the first
         * thing in its panel, which is where the review puts its tab blurbs too,
         * and a second copy pinned above the row would be prose the reader has
         * to skip past twice.
         */}
        <div className="mt-5" data-testid="concept-selector">
          <Tabs
            label="Concepts"
            layout="scroll"
            as="tabs"
            testIdPrefix="concept"
            value={active.id}
            onChange={select}
            options={CONCEPTS.map((c) => ({ value: c.id, label: c.label }))}
          />
        </div>

        {/*
         * Keyed on the concept, so switching tabs unmounts the old demo rather
         * than handing its seed, its matchup and its solve result to a component
         * that means something different by all three.
         */}
        <div
          className="mt-7"
          role="tabpanel"
          aria-label={active.label}
          data-testid="concept-panel"
          key={active.id}
        >
          <Panel />
        </div>

        <Reveal
          label="Where every number on this page comes from"
          summary="computed in your browser"
          testId="learn-provenance"
        >
          The hand review shows you what happened; this page shows you why any of
          it means anything. Every figure above was computed by the same modules
          the table plays with:{" "}
          <span className="font-mono">
            poker/monteCarlo.ts, poker/model/likelihood.ts,
            poker/model/buckets.ts, poker/ev.ts, poker/equity/multiway.ts
          </span>{" "}
          and <span className="font-mono">poker/solver/cfr.ts</span>. Nothing here
          is a stored figure.
        </Reveal>
      </PageBody>
    </main>
  );
}
