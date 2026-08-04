/**
 * The concepts surface.
 *
 * `LearnPage` is a route-ready page and wants one line in `src/App.tsx`:
 *
 *     <Route path="/learn" element={<LearnPage />} />
 *
 * inside the `AppShell` group, beside `/table` and `/review`. It needs no
 * provider, every number on it is computed from `poker/*` on the spot, so it
 * can sit outside the `TableProvider` group.
 *
 * `engine.ts` is the adapter layer between those modules and both explanatory
 * surfaces: the review's Math tab imports from it too, which is why the fold
 * equity worked on a real hand and the fold equity explained in the abstract can
 * never drift apart.
 */

export { default as LearnPage } from "./LearnPage";
export * from "./engine";
