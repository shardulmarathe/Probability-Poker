import { Profiler, type ProfilerOnRenderCallback } from "react";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Route, Routes } from "react-router-dom";
import { GameProvider } from "./store/GameContext";
import { TableProvider } from "./store/TableContext";
import { commitAction } from "./lib/latency";
import Home from "./pages/Home";
import Game from "./pages/Game";
import Analysis from "./pages/Analysis";
import TableGame from "./components/table/TableGame";

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
           * rather than around the whole app: a table left behind should stop
           * dealing, and re-entering should pick up whatever setup the home
           * screen just saved.
           */}
          <Route
            path="/table"
            element={
              <TableProvider>
                <TableGame />
              </TableProvider>
            }
          />
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
