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
 * `App.tsx`, and a route added to one and not the other still renders, it just
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
    // The functions must reach the filesystem handler, not the SPA shell -
    // otherwise every endpoint returns HTML and the client sees a parse error
    // instead of a 401.
    for (const url of ["/api/stats/me", "/api/hand/record", "/api/leaderboard"]) {
      expect(match(url), `${url} was captured by an SPA rule`).toBeUndefined();
    }
  });
});

/**
 * `vercel.json` is validated against a closed schema before anything is built,
 * and an unknown top-level key is a hard error, not a warning, and not
 * something any local command reports. A `"_comment"` array explaining why this
 * file uses `routes` instead of `rewrites` therefore failed *every* production
 * deploy for a day while `npm run build`, `tsc` and CI all stayed green,
 * because none of them read this file. The explanation lives in the comment
 * above instead, where it costs nothing.
 */
describe("vercel.json is a config Vercel will accept", () => {
  // Not the whole schema, the keys a project like this one can legitimately
  // use. Anything outside it is either a typo or a comment, and both break the
  // deploy the same way.
  const ALLOWED = new Set([
    "$schema",
    "build",
    "buildCommand",
    "cleanUrls",
    "crons",
    "devCommand",
    "framework",
    "functions",
    "git",
    "headers",
    "images",
    "installCommand",
    "outputDirectory",
    "public",
    "redirects",
    "regions",
    "rewrites",
    "routes",
    "trailingSlash",
    "version",
  ]);

  it("has no top-level key Vercel would reject", () => {
    const unknown = Object.keys(vercel).filter((k) => !ALLOWED.has(k));
    expect(unknown, `vercel.json would fail config validation on: ${unknown}`).toEqual(
      []
    );
  });

  it("routes nothing the router no longer serves", () => {
    // The reverse of the check above: a path deleted from App.tsx but left in
    // this table keeps answering 200 on the deployed site long after the page
    // is gone. /game and /analysis did exactly that.
    for (const url of ["/game", "/analysis"]) {
      expect(match(url)?.status, `${url} is gone and should 404`).toBe(404);
    }
  });
});
