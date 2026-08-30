import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Platforms cache og:image per-URL; versioning the URL with the deploy's
// commit SHA makes new shares fetch the latest screenshot, not a stale cache.
const ogVersion = (process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 8);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "og-image-cache-bust",
      transformIndexHtml: (html) =>
        html.replaceAll("/og.png", `/og.png?v=${ogVersion}`),
    },
  ],
  build: {
    // Vite 8 bundles with rolldown, so this is `rolldownOptions` and the
    // chunking key is `output.codeSplitting`, not rollup's `manualChunks`.
    rolldownOptions: {
      output: {
        codeSplitting: {
          /*
           * The lazy routes in `src/App.tsx` do most of the work; these groups
           * pin the three payloads that are large enough that letting the
           * automatic chunker place them leaves the naming and the boundaries
           * at the mercy of which page happens to import them first.
           *
           * Groups are matched in priority order and a module is claimed by
           * exactly one group, so the ordering here is load-bearing: `react`
           * must outrank `recharts`, or recharts' recursive dependency walk
           * would pull React into the chart chunk and every page would pay for
           * it.
           */
          groups: [
            {
              // Framework, versioned by upgrade rather than by deploy. Split
              // out so an app change does not invalidate it in the HTTP cache.
              name: "react-vendor",
              test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/,
              priority: 30,
            },
            {
              // Discounted CFR, exploitability and push/fold: reached from the
              // equilibrium concept on /learn and the river derivation in the
              // hand report, and from nowhere on the landing page or the felt.
              name: "solver",
              test: /[\\/]src[\\/]poker[\\/]solver[\\/]/,
              priority: 25,
              // Without this the group's dependency walk claims the shared
              // card and hand-evaluation modules underneath the solver, and a
              // chunk the landing page must load is a chunk the landing page
              // pays for.
              includeDependenciesRecursively: false,
            },
            {
              // recharts drags in the d3 modules it wraps, which is why this
              // is the biggest chunk in the build. Three components render a
              // chart (the equilibrium concept and two hand-report
              // derivations), and every one of them is behind a lazy route.
              name: "recharts",
              test: /node_modules[\\/]recharts[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
});
