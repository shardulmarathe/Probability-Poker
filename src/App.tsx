import { Profiler, type ProfilerOnRenderCallback } from "react";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Outlet, Route, Routes } from "react-router-dom";
import { TableProvider } from "./store/TableContext";
import { commitAction } from "./lib/latency";
import Home from "./pages/Home";
import TableGame from "./components/table/TableGame";
import HandReview from "./components/report/HandReview";
import Profile from "./components/profile/Profile";
import ProfileRecorder from "./components/profile/ProfileRecorder";
import ReplayPage from "./components/profile/ReplayPage";
import LearnPage from "./components/learn/LearnPage";
import { AppShell, NotFound } from "./components/shell";

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  // Attribute this commit's render cost to a pending bot decision (if any).
  commitAction(actualDuration);
};

export default function App() {
  return (
    <Profiler id="app" onRender={onRender}>
      <Routes>
        {/*
         * Every route sits inside the shell, so the felt is painted once and
         * the wordmark and the Table / Review / Profile navigation are on the
         * screen wherever you land — including on a mistyped URL.
         */}
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          {/* The concepts page needs no table — it works its examples with
              live engine calls of its own, so it sits outside the provider. */}
          <Route path="/learn" element={<LearnPage />} />
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
           */}
          <Route
            element={
              <TableProvider>
                <Outlet />
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
          {/* A real 404. This used to render <Home /> at whatever address was
              typed, which made a broken link look like a working one. */}
          <Route path="*" element={<NotFound />} />
        </Route>
        </Routes>
      <Analytics />
      <SpeedInsights />
    </Profiler>
  );
}
