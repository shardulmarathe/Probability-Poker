import { defineConfig } from "vitest/config";

// Pure-logic tests only, no DOM, no React. Kept deliberately separate from
// vite.config.ts so the app build never pulls in test configuration.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The slow tests are the engine self-play runs: they play real hands with
    // the bot deciding at production sim counts. 30s fails fast on a hang and
    // covers everything except the equity-ladder audit in
    // `poker/model/buckets.test.ts`, which measures 14 million rollouts and
    // passes its own longer timeout at the call site rather than raising this
    // ceiling for every test that should never approach it.
    testTimeout: 30_000,
  },
});
