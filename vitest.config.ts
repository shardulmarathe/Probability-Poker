import { defineConfig } from "vitest/config";

// Pure-logic tests only — no DOM, no React. Kept deliberately separate from
// vite.config.ts so the app build never pulls in test configuration.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The slow tests are the engine self-play runs: they play real hands with
    // the bot deciding at production sim counts, so the heaviest one takes a
    // few seconds (the evaluator property test, despite brute-forcing 100k+
    // deals, runs in ~1s). 30s leaves roughly 10x headroom over the current
    // worst case on slower CI hardware while still failing fast on a hang.
    testTimeout: 30_000,
  },
});
