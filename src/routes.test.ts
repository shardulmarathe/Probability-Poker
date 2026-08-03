import { describe, expect, it } from "vitest";
// Raw so the test reads the router as source rather than mounting React, and
// the JSON so it reads exactly what Vercel will serve.
import appSource from "./App.tsx?raw";
import vercel from "../vercel.json";

/**
 * `vercel.json` uses `routes` rather than `rewrites` because only `routes` can
 * attach a status code, and a single-page app that answers every URL with 200
 * tells crawlers that a mistyped path is a real page.
 *
 * The cost is a second source of truth: that table mirrors the router in
 * `App.tsx`, and a route added to one and not the other still renders — it just
 * answers 404. That already happened once, to `/learn`, within an hour of the
 * table being introduced. This test is the reason it cannot happen quietly
 * again.
 */

/** Every `path="…"` in the router, minus the catch-all. */
function routerPaths(): string[] {
  return [...appSource.matchAll(/path="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => p !== "*");
}

/** A concrete URL for a path, substituting any `:param` with something real. */
function sample(path: string): string {
  return path.replace(/:[A-Za-z]+/g, "7");
}

const rules = vercel.routes.filter(
  (r): r is { src: string; dest: string; status?: number } => "src" in r
);

function match(url: string) {
  return rules.find((r) => new RegExp(r.src).test(url));
}

describe("vercel.json covers the router", () => {
  it("finds the routes it is checking", () => {
    // Guards the regex above: if App.tsx stops using path="…" this test would
    // silently pass by checking nothing.
    const paths = routerPaths();
    expect(paths.length).toBeGreaterThanOrEqual(8);
    expect(paths).toContain("/table");
    expect(paths).toContain("/learn");
  });

  it("serves every real route with a 200", () => {
    for (const path of routerPaths()) {
      const url = sample(path);
      const rule = match(url);
      expect(rule, `${url} matches no rule in vercel.json`).toBeDefined();
      expect(rule?.status, `${url} would answer ${rule?.status}`).toBeUndefined();
    }
  });

  it("answers an unknown path with a real 404", () => {
    for (const url of ["/nonsense", "/table/deeper", "/reviews", "/learn/x"]) {
      expect(match(url)?.status, `${url} should 404`).toBe(404);
    }
  });

  it("never swallows an API path", () => {
    // The functions must reach the filesystem handler, not the SPA shell —
    // otherwise every endpoint returns HTML and the client sees a parse error
    // instead of a 401.
    for (const url of ["/api/stats/me", "/api/hand/record", "/api/leaderboard"]) {
      expect(match(url), `${url} was captured by an SPA rule`).toBeUndefined();
    }
  });
});
