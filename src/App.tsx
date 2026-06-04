import { Profiler, type ProfilerOnRenderCallback } from "react";
import { Analytics } from "@vercel/analytics/react";
import { Route, Routes } from "react-router-dom";
import { GameProvider } from "./store/GameContext";
import { commitAction } from "./lib/latency";
import Home from "./pages/Home";
import Game from "./pages/Game";
import Analysis from "./pages/Analysis";

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
          <Route path="/analysis" element={<Analysis />} />
          <Route path="/analysis/:handNumber" element={<Analysis />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </GameProvider>
      <Analytics />
    </Profiler>
  );
}
