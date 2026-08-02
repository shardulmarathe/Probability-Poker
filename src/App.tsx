import { Profiler, type ProfilerOnRenderCallback } from "react";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Outlet, Route, Routes } from "react-router-dom";
import { GameProvider } from "./store/GameContext";
import { TableProvider } from "./store/TableContext";
import { commitAction } from "./lib/latency";
import Home from "./pages/Home";
import Game from "./pages/Game";
import Analysis from "./pages/Analysis";
import TableGame from "./components/table/TableGame";
import HandReview from "./components/report/HandReview";
import Profile from "./components/profile/Profile";
import ProfileRecorder from "./components/profile/ProfileRecorder";
import ReplayPage from "./components/profile/ReplayPage";

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  // Attribute this commit's render cost to a pending bot decision (if any).
  commitAction(actualDuration);
};

export default function App() {
  return (
    <Profiler id="app" onRender={onRender}>
      <GameProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/game" element={<Game />} />
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
          <Route path="/analysis" element={<Analysis />} />
          <Route path="/analysis/:handNumber" element={<Analysis />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </GameProvider>
      <Analytics />
      <SpeedInsights />
    </Profiler>
  );
}
