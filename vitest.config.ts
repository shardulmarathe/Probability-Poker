import { defineConfig } from "vitest/config";

// Node by default: almost every suite here is pure logic against a seeded
// engine or a fake storage object, and a DOM would be setup cost for nothing.
// The handful of component suites opt in per file with
//
//     // @vitest-environment jsdom
//
// at the top, which keeps jsdom off the ~35 files that do not need it rather
// than making every test pay for the four that do. Kept deliberately separate
// from vite.config.ts so the app build never pulls in test configuration.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // The slow tests are the engine self-play runs: they play real hands with
    // the bot deciding at production sim counts. 30s fails fast on a hang and
    // covers everything except the equity-ladder audit in
    // `poker/model/buckets.test.ts`, which measures 14 million rollouts and
    // passes its own longer timeout at the call site rather than raising this
    // ceiling for every test that should never approach it.
    testTimeout: 30_000,
  },
});
