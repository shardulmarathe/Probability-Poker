/**
 * End-to-end bot decision latency tracking.
 *
 * A single decision is timed across its phases:
 *   - mc       : Monte Carlo simulation time
 *   - ev       : expected-value calculation time
 *   - compute  : the whole decision, kickoff to resolved (clone + MC + EV, and
 *                the worker round trip, which is why it is wall-clock not CPU)
 *   - render   : React commit duration for the resulting update (from <Profiler>)
 *   - total    : compute + render, the work on the decision-to-render path
 *
 * `total` is a sum, not a stopwatch reading, and deliberately so: the store
 * holds the decision behind a ~1.2-1.8s "thinking" beat, and a wall-clock total
 * would be that beat plus noise rather than anything about the engine.
 *
 * Timings flow: the store calls `beginAction()` once the decision has landed and
 * immediately before the state commit that renders it, so the <Profiler>'s next
 * `commitAction()` is the render of this decision. Commits before that point
 * have nothing pending and are ignored. The breakdown is logged to the console.
 */

export interface ActionTimings {
  mc: number;
  ev: number;
  compute: number;
}

let pending: ActionTimings | null = null;

/** Enable verbose per-action logging via `localStorage.ppLatency = "1"`. */
function enabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem("ppLatency") !== "0";
  } catch {
    return true;
  }
}

export function beginAction(timings: ActionTimings): void {
  pending = timings;
}

/** Called from the React Profiler after a commit. `renderMs` = actualDuration. */
export function commitAction(renderMs: number): void {
  if (!pending) return;
  const total = pending.compute + renderMs;
  const row = {
    "Monte Carlo (ms)": round(pending.mc),
    "EV calc (ms)": round(pending.ev),
    "Compute total (ms)": round(pending.compute),
    "React render (ms)": round(renderMs),
    "Total latency (ms)": round(total),
  };
  pending = null;
  if (!enabled()) return;
  // eslint-disable-next-line no-console
  console.log(
    `%cBot decision latency`,
    "color:#38bdf8;font-weight:bold",
    `${row["Total latency (ms)"]}ms total`
  );
  // eslint-disable-next-line no-console
  if (console.table) console.table(row);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
