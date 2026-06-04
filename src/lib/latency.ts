/**
 * End-to-end bot decision latency tracking.
 *
 * A single decision is timed across its phases:
 *   - mc       : Monte Carlo simulation time
 *   - ev       : expected-value calculation time
 *   - compute  : total synchronous engine step (decision + apply + state clone)
 *   - render   : React commit duration for the resulting update (from <Profiler>)
 *   - total    : wall-clock from decision start until the commit lands
 *
 * Timings flow: the store calls `beginAction()` right before computing the bot
 * move, and the app's <Profiler> calls `commitAction()` after the resulting
 * React commit. The breakdown is logged to the console.
 */

export interface ActionTimings {
  mc: number;
  ev: number;
  compute: number;
}

interface Pending extends ActionTimings {
  startedAt: number;
}

let pending: Pending | null = null;

/** Enable verbose per-action logging via `localStorage.ppLatency = "1"`. */
function enabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem("ppLatency") !== "0";
  } catch {
    return true;
  }
}

export function beginAction(startedAt: number, timings: ActionTimings): void {
  pending = { startedAt, ...timings };
}

/** Called from the React Profiler after a commit. `renderMs` = actualDuration. */
export function commitAction(renderMs: number): void {
  if (!pending) return;
  const total = performance.now() - pending.startedAt;
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
    `%c🤖 Bot decision latency`,
    "color:#38bdf8;font-weight:bold",
    `— ${row["Total latency (ms)"]}ms total`
  );
  // eslint-disable-next-line no-console
  if (console.table) console.table(row);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
