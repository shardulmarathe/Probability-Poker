/**
 * The concepts surface.
 *
 * `LearnPage` is a route-ready page and wants one line in `src/App.tsx`:
 *
 *     <Route path="/learn" element={<LearnPage />} />
 *
 * inside the `AppShell` group, beside `/table` and `/review`. It needs no
 * provider, every number on it is computed from `poker/*` on the spot, so it
 * can sit outside the `TableProvider` group. One route is all it wants: the
 * seven concepts are selected with `?c=`, deliberately not with seven paths,
 * because `vercel.json` mirrors the router by hand and has 404'd this page once
 * already by falling out of step with it.
 *
 * The page itself is the selector and the header; each concept is a module
 * under `concepts/`, listed once in `concepts/index.ts`, and `controls.tsx`
 * holds the two controls they share.
 *
 * `engine.ts` is the adapter layer between those modules and both explanatory
 * surfaces: the review's Math tab imports from it too, which is why the fold
 * equity worked on a real hand and the fold equity explained in the abstract can
 * never drift apart.
 */

export { default as LearnPage } from "./LearnPage";
export * from "./engine";
