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
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { money } from "../../lib/format";
import { replayHand } from "../../poker/replay";
import { EmptyPanel, FeltBackground, Rail, Section, Tag } from "../report/ui";
import { Scrubber } from "./Scrubber";
import { CounterfactualPanel, LineupPanel } from "./WhatIf";
import { useProfileArchive } from "./useProfile";

type TabId = "step" | "whatif" | "lineup";

const TABS: { id: TabId; label: string; blurb: string }[] = [
  { id: "step", label: "Step through", blurb: "The hand as it happened" },
  { id: "whatif", label: "What if", blurb: "Change one decision" },
  { id: "lineup", label: "Other table", blurb: "Same cards, different opponents" },
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
      <Shell>
        <div className="mt-10">
          <EmptyPanel title="No hand to replay">
            Nothing has been archived yet. Play a hand at the table and it will
            be replayable here, dealt again from its own seed.
            <div className="mt-4">
              <Link
                to="/table"
                className="inline-block min-h-[44px] rounded-xl border border-pkred-light/70 bg-pkred/80 px-6 py-3 font-display font-semibold text-ivory transition hover:-translate-y-0.5 hover:bg-pkred-light"
              >
                Go to the table
              </Link>
            </div>
          </EmptyPanel>
        </div>
      </Shell>
    );
  }

  const index = hands.findIndex((h) => h.seed === report.seed);
  const mine = report.seats.find((s) => s.seat === seat);

  return (
    <Shell
      header={
        <div className="flex flex-wrap items-center gap-2">
          <button
            data-testid="replay-prev"
            disabled={index <= 0}
            onClick={() => navigate(`/replay/${hands[index - 1].seed}`)}
            className="min-h-[36px] rounded-lg border px-2.5 py-1 font-display text-xs transition disabled:opacity-30"
            style={{ borderColor: "rgba(201,162,39,0.35)", background: "rgba(0,0,0,0.35)" }}
            aria-label="Previous hand"
          >
            ‹
          </button>
          <select
            data-testid="replay-select"
            value={report.seed}
            onChange={(e) => navigate(`/replay/${e.target.value}`)}
            className="min-h-[36px] rounded-lg border px-3 py-1.5 font-display text-xs text-ivory outline-none sm:text-sm"
            style={{ borderColor: "rgba(201,162,39,0.4)", background: "rgba(0,0,0,0.4)" }}
          >
            {hands.map((h) => (
              <option key={h.seed} value={h.seed} className="bg-[#0b2218]">
                Hand #{h.handNumber} · {h.seatCount}-handed
              </option>
            ))}
          </select>
          <button
            data-testid="replay-next"
            disabled={index < 0 || index >= hands.length - 1}
            onClick={() => navigate(`/replay/${hands[index + 1].seed}`)}
            className="min-h-[36px] rounded-lg border px-2.5 py-1 font-display text-xs transition disabled:opacity-30"
            style={{ borderColor: "rgba(201,162,39,0.35)", background: "rgba(0,0,0,0.35)" }}
            aria-label="Next hand"
          >
            ›
          </button>
          <Rail>{hands.length} archived</Rail>
        </div>
      }
      subtitle={`Hand #${report.handNumber} — ${report.seatCount}-handed, dealt from seed ${report.seed}.${
        mine ? ` ${seatName(seat)} netted ${mine.net >= 0 ? `+${money(mine.net)}` : `−${money(-mine.net)}`}.` : ""
      }`}
    >
      {/* --------------------- Fidelity ---------------------- */}
      <div
        className="mt-5 rounded-xl border p-3"
        style={{
          borderColor: replay.fidelity.ok ? "rgba(95,185,143,0.45)" : "rgba(210,74,74,0.5)",
          background: replay.fidelity.ok ? "rgba(95,185,143,0.08)" : "rgba(210,74,74,0.08)",
        }}
        data-testid="fidelity"
        data-ok={replay.fidelity.ok}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={replay.fidelity.ok ? "good" : "bad"}>
            {replay.fidelity.ok ? "Reconstruction verified" : "Reconstruction failed"}
          </Tag>
          <span className="font-mono text-[0.62rem] uppercase tracking-wider text-ivory/45">
            {replay.fidelity.actionsApplied}/{replay.fidelity.actionsRecorded} actions replayed
          </span>
        </div>
        <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ivory/65">
          {replay.fidelity.ok ? (
            <>
              The engine was given this hand's seed and dealt it again. Every card,
              every side pot and every seat's net came out identical to the record —
              so what you are stepping through is the hand, not a reconstruction of
              it.
            </>
          ) : (
            <>
              This hand did not rebuild identically, so the steps below may not be
              what happened. The simulated views are disabled.
            </>
          )}
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
      <div
        className="sticky top-0 z-30 -mx-3 mt-4 px-3 py-2 sm:-mx-4 sm:px-4"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,15,10,0.96) 0%, rgba(6,15,10,0.82) 70%, rgba(6,15,10,0) 100%)",
          backdropFilter: "blur(6px)",
        }}
      >
        <div
          role="tablist"
          aria-label="Replay sections"
          className="flex gap-1 rounded-xl border p-1"
          style={{ borderColor: "rgba(201,162,39,0.3)", background: "rgba(0,0,0,0.45)" }}
        >
          {TABS.map((t) => {
            const active = t.id === tab;
            const locked = t.id !== "step" && !replay.fidelity.ok;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                title={t.blurb}
                disabled={locked}
                data-testid={`replay-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className="min-h-[38px] min-w-0 flex-1 truncate rounded-lg px-1.5 py-2 font-display text-[0.68rem] font-semibold tracking-wide transition disabled:opacity-30 sm:px-3 sm:text-sm"
                style={{
                  background: active ? "rgba(201,162,39,0.22)" : "transparent",
                  color: active ? "#e2c563" : "rgba(244,237,228,0.6)",
                  boxShadow: active ? "inset 0 0 0 1px rgba(201,162,39,0.45)" : "none",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---------------------- Panels ----------------------- */}
      <div className="mt-4" data-testid="replay-panel" data-tab={tab}>
        {tab === "step" && (
          <Section title="Step through" subtitle="Rebuilt from the seed, action by action">
            <Scrubber
              frames={replay.frames}
              index={frame}
              onIndex={setFrame}
              button={report.button}
              seatCount={report.seatCount}
              focus={seat}
              seatName={seatName}
            />
          </Section>
        )}

        {tab === "whatif" && replay.fidelity.ok && (
          <Section title="What if" subtitle="One decision changed — everything after it is simulated">
            <CounterfactualPanel
              report={report}
              options={options}
              seat={seat}
              seatName={seatName}
            />
          </Section>
        )}

        {tab === "lineup" && replay.fidelity.ok && (
          <Section title="Other table" subtitle="Same cards, different opponents — all of it simulated">
            <LineupPanel report={report} options={options} seat={seat} seatName={seatName} />
          </Section>
        )}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  header,
  subtitle,
}: {
  children: React.ReactNode;
  header?: React.ReactNode;
  subtitle?: string;
}) {
  return (
    <main
      className="relative min-h-[100svh] overflow-x-hidden text-ivory"
      data-testid="replay"
    >
      <FeltBackground />
      <div
        className="relative z-10 mx-auto max-w-4xl px-3 pb-12 pt-4 sm:px-4 sm:pt-6"
        style={{
          paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
          paddingRight: "max(0.75rem, env(safe-area-inset-right))",
        }}
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              to="/profile"
              className="font-display text-xs tracking-wide text-ivory/70 transition hover:text-ivory sm:text-sm"
            >
              ← Back to profile
            </Link>
            <h1 className="mt-1.5 font-display text-[clamp(1.5rem,6vw,2.1rem)] font-bold tracking-tight text-gold-soft">
              Hand Replay
            </h1>
            <p className="mt-1 max-w-xl text-[0.8rem] leading-relaxed text-ivory/55 sm:text-sm">
              {subtitle ?? "Every hand is a function of its seed, so it can be dealt again exactly."}
            </p>
          </div>
          {header}
        </header>
        {children}
      </div>
    </main>
  );
}
