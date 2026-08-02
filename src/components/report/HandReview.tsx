/**
 * The hand review.
 *
 * Four tabs, one question each: what happened, what they had, what you did, and
 * why the numbers are the numbers. Splitting it that way rather than by data
 * source is deliberate — the same equity estimate shows up on three of these
 * pages, answering a different question every time.
 *
 * The whole thing reads `history` off `TableContext` and nothing else. There is
 * no store here, no fetch and no persistence: a review is a pure function of a
 * finished hand, and the moment it starts keeping its own copy of one, the copy
 * can disagree with the table.
 */

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { money } from "../../lib/format";
import { useTable } from "../../store/TableContext";
import { HandTab } from "./HandTab";
import { MathTab } from "./MathTab";
import { PlayTab } from "./PlayTab";
import { RangeGridStyles } from "./RangeGrid";
import { RangesTab } from "./RangesTab";
import { STREET_LABEL, seatResult } from "./derive";
import { FeltBackground, Rail } from "./ui";

type TabId = "hand" | "ranges" | "play" | "math";

const TABS: { id: TabId; label: string; blurb: string }[] = [
  { id: "hand", label: "Hand", blurb: "What happened" },
  { id: "ranges", label: "Ranges", blurb: "What they had" },
  { id: "play", label: "Your Play", blurb: "What it cost" },
  { id: "math", label: "Math", blurb: "Where the numbers come from" },
];

export default function HandReview() {
  const { history, lastReport, table, heroSeat } = useTable();
  const params = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>("hand");

  const hands = useMemo(() => {
    const all = [...history];
    if (lastReport && !all.some((r) => r.handNumber === lastReport.handNumber)) {
      all.push(lastReport);
    }
    return all.sort((a, b) => a.handNumber - b.handNumber);
  }, [history, lastReport]);

  const requested = params.handNumber ? Number(params.handNumber) : undefined;
  const report =
    hands.find((r) => r.handNumber === requested) ?? hands[hands.length - 1] ?? null;

  const seatName = useMemo(() => {
    const names = table.seats.map((s) => s.name);
    return (seat: number) => names[seat] ?? `Seat ${seat + 1}`;
  }, [table.seats]);

  // The seat the review is written from. The human when there is one; otherwise
  // the seat that put the most chips in, which is the hand worth reading.
  const defaultFocus = useMemo(() => {
    if (heroSeat !== null) return heroSeat;
    if (!report) return 0;
    return report.seats.reduce(
      (best, s) => (s.invested > (seatResult(report, best)?.invested ?? -1) ? s.seat : best),
      report.seats[0]?.seat ?? 0
    );
  }, [heroSeat, report]);
  const [focusOverride, setFocusOverride] = useState<number | null>(null);
  const focus = focusOverride ?? defaultFocus;
  const isHero = heroSeat !== null && focus === heroSeat;

  const index = report ? hands.findIndex((r) => r.handNumber === report.handNumber) : -1;

  return (
    <main
      className="relative min-h-[100svh] overflow-x-hidden text-ivory"
      data-testid="review"
      data-tab={tab}
      data-hands={hands.length}
      data-hand={report?.handNumber ?? ""}
    >
      <FeltBackground />
      <RangeGridStyles />

      <div
        className="relative z-10 mx-auto max-w-6xl px-3 pb-10 pt-4 sm:px-4 sm:pt-6"
        style={{
          paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
          paddingRight: "max(0.75rem, env(safe-area-inset-right))",
        }}
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              to="/table"
              className="font-display text-xs tracking-wide text-ivory/70 transition hover:text-ivory sm:text-sm"
            >
              ← Back to table
            </Link>
            <h1 className="mt-1.5 font-display text-[clamp(1.5rem,6vw,2.1rem)] font-bold tracking-tight text-gold-soft">
              Hand Review
            </h1>
            <p className="mt-1 max-w-xl text-[0.8rem] leading-relaxed text-ivory/55 sm:text-sm">
              {report
                ? `Hand #${report.handNumber} — ${report.seatCount}-handed, ended on the ${STREET_LABEL[report.endStreet].toLowerCase()}.`
                : "Every finished hand, opened up."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hands.length > 0 && (
              <>
                <button
                  data-testid="review-prev"
                  disabled={index <= 0}
                  onClick={() => navigate(`/review/${hands[index - 1].handNumber}`)}
                  className="min-h-[36px] rounded-lg border px-2.5 py-1 font-display text-xs transition disabled:opacity-30"
                  style={{
                    borderColor: "rgba(201,162,39,0.35)",
                    background: "rgba(0,0,0,0.35)",
                  }}
                  aria-label="Previous hand"
                >
                  ‹
                </button>
                <select
                  data-testid="review-select"
                  value={report?.handNumber ?? ""}
                  onChange={(e) => navigate(`/review/${e.target.value}`)}
                  className="min-h-[36px] rounded-lg border px-3 py-1.5 font-display text-xs text-ivory outline-none sm:text-sm"
                  style={{
                    borderColor: "rgba(201,162,39,0.4)",
                    background: "rgba(0,0,0,0.4)",
                  }}
                >
                  {hands.map((r) => (
                    <option key={r.handNumber} value={r.handNumber} className="bg-[#0b2218]">
                      Hand #{r.handNumber}
                    </option>
                  ))}
                </select>
                <button
                  data-testid="review-next"
                  disabled={index < 0 || index >= hands.length - 1}
                  onClick={() => navigate(`/review/${hands[index + 1].handNumber}`)}
                  className="min-h-[36px] rounded-lg border px-2.5 py-1 font-display text-xs transition disabled:opacity-30"
                  style={{
                    borderColor: "rgba(201,162,39,0.35)",
                    background: "rgba(0,0,0,0.35)",
                  }}
                  aria-label="Next hand"
                >
                  ›
                </button>
              </>
            )}
            <Rail>{hands.length} hand{hands.length === 1 ? "" : "s"}</Rail>
          </div>
        </header>

        {!report ? (
          <EmptyReview />
        ) : (
          <>
            {/* --------------------------- Tabs --------------------------- */}
            <div
              className="sticky top-0 z-30 -mx-3 mt-5 px-3 py-2 sm:-mx-4 sm:px-4"
              style={{
                background:
                  "linear-gradient(180deg, rgba(6,15,10,0.96) 0%, rgba(6,15,10,0.82) 70%, rgba(6,15,10,0) 100%)",
                backdropFilter: "blur(6px)",
              }}
            >
              <div
                role="tablist"
                aria-label="Hand review sections"
                className="flex gap-1 rounded-xl border p-1"
                style={{
                  borderColor: "rgba(201,162,39,0.3)",
                  background: "rgba(0,0,0,0.45)",
                }}
              >
                {TABS.map((t) => {
                  const active = t.id === tab;
                  return (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={active}
                      title={t.blurb}
                      data-testid={`tab-${t.id}`}
                      onClick={() => setTab(t.id)}
                      className="min-h-[38px] min-w-0 flex-1 truncate rounded-lg px-1.5 py-2 font-display text-[0.68rem] font-semibold tracking-wide transition sm:px-3 sm:text-sm"
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

            {/* ---------------------- Viewpoint seat ---------------------- */}
            {table.seats.length > 1 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[0.58rem] uppercase tracking-[0.2em] text-ivory/35">
                  Reviewing from
                </span>
                <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
                  {report.seats.map((s) => {
                    const active = s.seat === focus;
                    return (
                      <button
                        key={s.seat}
                        data-testid={`focus-${s.seat}`}
                        onClick={() => setFocusOverride(s.seat)}
                        className="min-h-[30px] shrink-0 rounded-md border px-2 py-1 font-display text-[0.62rem] tracking-wide transition"
                        style={{
                          borderColor: active
                            ? "rgba(201,162,39,0.6)"
                            : "rgba(244,237,228,0.14)",
                          background: active ? "rgba(201,162,39,0.18)" : "rgba(0,0,0,0.3)",
                          color: active ? "#e2c563" : "rgba(244,237,228,0.55)",
                        }}
                      >
                        {seatName(s.seat)}
                        {heroSeat === s.seat ? " (you)" : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* -------------------------- Panels -------------------------- */}
            <div
              className="mt-4"
              data-testid="review-panel"
              role="tabpanel"
              key={`${report.handNumber}:${focus}`}
            >
              {tab === "hand" && (
                <HandTab
                  report={report}
                  focus={focus}
                  seatName={seatName}
                  isHero={isHero}
                />
              )}
              {tab === "ranges" && (
                <RangesTab
                  report={report}
                  focus={focus}
                  seatName={seatName}
                  isHero={isHero}
                />
              )}
              {tab === "play" && (
                <PlayTab
                  report={report}
                  focus={focus}
                  seatName={seatName}
                  isHero={isHero}
                />
              )}
              {tab === "math" && (
                <MathTab report={report} focus={focus} seatName={seatName} />
              )}
            </div>

            {/* ------------------------- Hand list ------------------------ */}
            <div className="mt-8">
              <p className="mb-2 font-display text-[0.62rem] uppercase tracking-[0.22em] text-ivory/40">
                This session
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {hands
                  .slice()
                  .reverse()
                  .map((r) => {
                    const mine = seatResult(r, focus);
                    const active = r.handNumber === report.handNumber;
                    return (
                      <Link
                        key={r.handNumber}
                        to={`/review/${r.handNumber}`}
                        className="rounded-xl border p-2.5 transition hover:-translate-y-0.5"
                        style={{
                          borderColor: active
                            ? "rgba(201,162,39,0.6)"
                            : "rgba(244,237,228,0.14)",
                          background: active ? "rgba(201,162,39,0.1)" : "rgba(0,0,0,0.25)",
                        }}
                      >
                        <p className="font-display text-xs font-semibold text-ivory">
                          Hand #{r.handNumber}
                        </p>
                        <p className="text-[0.65rem] text-ivory/50">
                          {STREET_LABEL[r.endStreet]}
                          {r.wentToShowdown ? " · showdown" : ""}
                        </p>
                        <p
                          className="mt-1 font-mono text-[0.7rem]"
                          style={{
                            color:
                              (mine?.net ?? 0) > 0
                                ? "#7fd3a8"
                                : (mine?.net ?? 0) < 0
                                  ? "#e58a8a"
                                  : "rgba(244,237,228,0.4)",
                          }}
                        >
                          {mine
                            ? mine.net >= 0
                              ? `+${money(mine.net)}`
                              : `−${money(-mine.net)}`
                            : "—"}
                        </p>
                      </Link>
                    );
                  })}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function EmptyReview() {
  return (
    <div className="mt-16 flex flex-col items-center gap-4 text-center">
      <p className="max-w-md text-ivory/60">
        No hand has finished yet. Play one out at the table and it will be waiting
        here — cards, chips, ranges and all.
      </p>
      <Link
        to="/table"
        className="min-h-[46px] rounded-xl border border-pkred-light/70 bg-pkred/80 px-6 py-3 font-display font-semibold text-ivory transition hover:-translate-y-0.5 hover:bg-pkred-light"
      >
        Go to the table
      </Link>
    </div>
  );
}
