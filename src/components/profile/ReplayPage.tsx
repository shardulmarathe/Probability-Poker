/**
 * Hand replay.
 *
 * The page opens on the reconstruction — the recorded hand, rebuilt from its
 * seed and stepped through action by action — and puts the fidelity check at
 * the top rather than hiding it. That badge is the difference between a replay
 * and a story: it says the engine was handed the seed, dealt the hand again,
 * and produced a report that matched the recorded one in every field a chip
 * touched. When it does not match, the page says so and refuses to pretend.
 *
 * The two simulated views live behind their own tabs and their own colour. See
 * `WhatIf.tsx` for why they are so insistent about it.
 *
 * The tab bar used to be a near byte-for-byte copy of the hand review's,
 * inlined here — same gradient, same sticky wrapper, same active treatment
 * written out a second time. It is now `Tabs` + `StickyTabs` from the design
 * system, which also means the tab blurbs ("Change one decision") are printed
 * under the row instead of hidden in a `title=` attribute no phone shows.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { money } from "../../lib/format";
import { replayHand } from "../../poker/replay";
import { PageBody, PageHeader } from "../shell";
import {
  Button,
  ButtonLink,
  EmptyState,
  LINE,
  RADIUS,
  Rail,
  StickyTabs,
  Tabs,
  Tag,
} from "../ui";
import { Scrubber } from "./Scrubber";
import { CounterfactualPanel, LineupPanel } from "./WhatIf";
import { useProfileArchive } from "./useProfile";

type TabId = "step" | "whatif" | "lineup";

const TABS: { id: TabId; label: string; blurb: string }[] = [
  { id: "step", label: "Step through", blurb: "The hand exactly as it was dealt." },
  {
    id: "whatif",
    label: "What if",
    blurb: "Replace one of your decisions and let the bots answer it now.",
  },
  {
    id: "lineup",
    label: "Other table",
    blurb: "The same cards, dealt to a different set of opponents.",
  },
];

export default function ReplayPage() {
  const { hands, seat, seatName, smallBlind, bigBlind } = useProfileArchive();
  const params = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>("step");
  const [frame, setFrame] = useState(0);

  const config = useMemo(() => ({ smallBlind, bigBlind }), [smallBlind, bigBlind]);

  // Hands are addressed by deal seed below, so the seat count is known before
  // the report is; `seatCount` here is the archive's widest table, which is all
  // `seatName` needs. Names go into the replay table itself so the engine's own
  // narration ("Textbook Tara raises to $40") matches the seats on screen.
  const options = useMemo(
    () => ({
      config,
      seats: Array.from({ length: 6 }, (_, i) => ({ name: seatName(i) })),
    }),
    [config, seatName]
  );

  // Hands are addressed by deal seed, not hand number: numbers restart at 1 for
  // every new table, so a link to "#3" would mean a different hand tomorrow.
  const requested = params.seed ? Number(params.seed) : undefined;
  const report =
    hands.find((h) => h.seed === requested) ?? hands[hands.length - 1] ?? null;

  const replay = useMemo(
    () => (report ? replayHand(report, options) : null),
    [report, options]
  );

  // Land on the deal whenever the hand changes, rather than on whatever frame
  // index the previous hand happened to be scrubbed to.
  useEffect(() => setFrame(0), [report?.seed]);

  if (!report || !replay) {
    return (
      <main className="relative overflow-x-hidden text-ivory" data-testid="replay">
        <PageBody width="narrow">
          <PageHeader
            title="Hand replay"
            lede="Every hand is a function of its seed, so any hand you have played can be dealt again exactly."
          />
          <div className="mt-10">
            <EmptyState
              title="Nothing archived to replay yet"
              action={
                <ButtonLink to="/table" variant="primary" size="lg">
                  Go to the table
                </ButtonLink>
              }
            >
              Play a hand out and it becomes replayable here — stepped through
              action by action, with the option to change one of your decisions
              and watch the table answer it differently.
            </EmptyState>
          </div>
        </PageBody>
      </main>
    );
  }

  const index = hands.findIndex((h) => h.seed === report.seed);
  const mine = report.seats.find((s) => s.seat === seat);

  return (
    <main className="relative overflow-x-hidden text-ivory" data-testid="replay">
      <PageBody width="narrow">
        <PageHeader
          title="Hand replay"
          lede={
            <>
              Hand #{report.handNumber} — {report.seatCount}-handed, dealt from
              seed {report.seed}.
              {mine
                ? ` ${seatName(seat)} netted ${mine.net >= 0 ? `+${money(mine.net)}` : `−${money(-mine.net)}`}.`
                : ""}
            </>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="quiet"
                data-testid="replay-prev"
                disabled={index <= 0}
                onClick={() => navigate(`/replay/${hands[index - 1].seed}`)}
                aria-label="Previous hand"
              >
                ‹
              </Button>
              <select
                data-testid="replay-select"
                aria-label="Hand to replay"
                value={report.seed}
                onChange={(e) => navigate(`/replay/${e.target.value}`)}
                className={`min-h-[34px] border px-3 py-1.5 font-display text-xs text-ivory outline-none sm:text-sm ${RADIUS.action}`}
                style={{ borderColor: LINE.gold, background: "rgba(0,0,0,0.4)" }}
              >
                {hands.map((h) => (
                  <option key={h.seed} value={h.seed} className="bg-[#0b2218]">
                    Hand #{h.handNumber} · {h.seatCount}-handed
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="quiet"
                data-testid="replay-next"
                disabled={index < 0 || index >= hands.length - 1}
                onClick={() => navigate(`/replay/${hands[index + 1].seed}`)}
                aria-label="Next hand"
              >
                ›
              </Button>
            </div>
          }
          meta={<Rail>{hands.length} archived</Rail>}
        />

        {/* --------------------- Fidelity ---------------------- */}
        <div
          className={`mt-6 border p-3.5 ${RADIUS.surface}`}
          style={{
            borderColor: replay.fidelity.ok
              ? "rgba(95,185,143,0.45)"
              : "rgba(210,74,74,0.5)",
            background: replay.fidelity.ok
              ? "rgba(95,185,143,0.08)"
              : "rgba(210,74,74,0.08)",
          }}
          data-testid="fidelity"
          data-ok={replay.fidelity.ok}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone={replay.fidelity.ok ? "good" : "bad"}>
              {replay.fidelity.ok ? "Reconstruction verified" : "Reconstruction failed"}
            </Tag>
            <span className="font-mono text-[0.62rem] uppercase tracking-wider text-ivory/45">
              {replay.fidelity.actionsApplied}/{replay.fidelity.actionsRecorded} actions
              replayed
            </span>
          </div>
          <p className="mt-1.5 text-[0.78rem] leading-relaxed text-ivory/65">
            {replay.fidelity.ok
              ? "The engine was given this hand's seed and dealt it again. Every card, every side pot and every seat's net came out identical to the record — so what you are stepping through is the hand, not a reconstruction of it."
              : "This hand did not rebuild identically, so the steps below may not be what happened. The simulated views are disabled."}
          </p>
          {!replay.fidelity.ok && (
            <ul className="mt-2 space-y-0.5" data-testid="fidelity-mismatches">
              {replay.fidelity.mismatches.slice(0, 4).map((line, i) => (
                <li key={i} className="font-mono text-[0.68rem]" style={{ color: "#e58a8a" }}>
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ----------------------- Tabs ------------------------ */}
        <StickyTabs>
          <Tabs
            label="Replay views"
            layout="fill"
            showHint
            testIdPrefix="replay-tab"
            value={tab}
            onChange={setTab}
            options={TABS.map((t) => ({
              value: t.id,
              label: t.label,
              hint: t.blurb,
              disabled: t.id !== "step" && !replay.fidelity.ok,
            }))}
          />
        </StickyTabs>

        {/*
         * No heading here. The tab above is the heading, and its hint is the
         * lede — printing "Step through / Rebuilt from the seed" underneath a
         * tab reading "Step through" said the same thing three times.
         */}
        <div className="mt-5" data-testid="replay-panel" data-tab={tab}>
          {tab === "step" && (
            <Scrubber
              frames={replay.frames}
              index={frame}
              onIndex={setFrame}
              button={report.button}
              seatCount={report.seatCount}
              focus={seat}
              seatName={seatName}
            />
          )}

          {tab === "whatif" && replay.fidelity.ok && (
            <CounterfactualPanel
              report={report}
              options={options}
              seat={seat}
              seatName={seatName}
            />
          )}

          {tab === "lineup" && replay.fidelity.ok && (
            <LineupPanel
              report={report}
              options={options}
              seat={seat}
              seatName={seatName}
            />
          )}
        </div>
      </PageBody>
    </main>
  );
}
