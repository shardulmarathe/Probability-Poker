import { lazy, Suspense } from "react";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Outlet, Route, Routes } from "react-router-dom";
import { TableProvider } from "./store/TableContext";
import Home from "./pages/Home";
import ProfileRecorder from "./components/profile/ProfileRecorder";
import { AppShell, NotFound } from "./components/shell";

/*
 * Route-level splitting. `Home` is the landing page and the only thing a first
 * visit is guaranteed to render, so it stays in the entry chunk; every other
 * page is fetched when its URL is first visited.
 *
 * `AppShell`, `TableProvider` and `ProfileRecorder` are deliberately static
 * imports even though they only matter to routes below them. They sit above
 * the page components in the tree, so a lazy one would have to resolve before
 * React could even discover the page's own import, turning one request into a
 * chain of three. They are small; the pages and their engines are not.
 */
const LearnPage = lazy(() => import("./components/learn/LearnPage"));
const TableGame = lazy(() => import("./components/table/TableGame"));
const HandReview = lazy(() => import("./components/report/HandReview"));
const Profile = lazy(() => import("./components/profile/Profile"));
const ReplayPage = lazy(() => import("./components/profile/ReplayPage"));

export default function App() {
  return (
    <>
      <Routes>
        {/*
         * Every route sits inside the shell, so the felt is painted once and
         * the wordmark and the Table / Review / Profile navigation are on the
         * screen wherever you land, including on a mistyped URL.
         */}
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          {/* The concepts page needs no table - it works its examples with
              live engine calls of its own, so it sits outside the provider.

              Its `<Suspense>` sits here rather than around the shell: a
              boundary above `AppShell` would swap the whole felt for the
              fallback and the header would jump. The fallback is `null` for
              the same reason. The shell has already painted, so an empty
              content area for the length of one chunk fetch is the smallest
              possible visual event, where a spinner would be a second layout
              that appears and then leaves. */}
          <Route
            path="/learn"
            element={
              <Suspense fallback={null}>
                <LearnPage />
              </Suspense>
            }
          />
          {/*
           * The N-handed table provides its own store, mounted with the route
           * group rather than around the whole app: a table left behind should
           * stop dealing, and re-entering should pick up whatever setup the home
           * screen just saved.
           *
           * `/review` sits inside that same group so the two share one provider
           * instance. The hand history lives in the store and nowhere else, so a
           * separately-mounted review route would deal itself a fresh table and
           * find an empty archive.
           *
           * The group's `<Suspense>` is inside `TableProvider`, not around it.
           * A boundary above the provider would put the live table in the
           * hidden half of a suspended boundary every time a sibling route's
           * chunk was fetched, and the hand in progress is store state.
           */}
          <Route
            element={
              <TableProvider>
                <Suspense fallback={null}>
                  <Outlet />
                </Suspense>
              </TableProvider>
            }
          >
            {/*
             * A pathless layout route so the profile's archive is written for
             * every page in the group, not just its own. Hands have to survive
             * a reload from `/table`, and the store's history does not.
             */}
            <Route element={<ProfileRecorder />}>
              <Route path="/table" element={<TableGame />} />
              <Route path="/review" element={<HandReview />} />
              <Route path="/review/:handNumber" element={<HandReview />} />
              <Route path="/profile" element={<Profile />} />
              {/* Replays are addressed by deal seed: hand numbers restart with
                  every new table, seeds do not. */}
              <Route path="/replay" element={<ReplayPage />} />
              <Route path="/replay/:seed" element={<ReplayPage />} />
            </Route>
          </Route>
          {/* A real 404, eager because it is the answer to a bad link and must
              not spend a round trip deciding to say so. */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Analytics />
      <SpeedInsights />
    </>
  );
}
