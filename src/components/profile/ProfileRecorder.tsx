/**
 * A pathless layout route that archives finished hands.
 *
 * It wraps every page inside the table's provider group and renders nothing of
 * its own, so the archive fills up while you play rather than only while you
 * are looking at the profile. Without it, a session played at `/table` and then
 * reloaded would leave nothing behind — the store's history dies with the tab.
 */

import { Outlet } from "react-router-dom";
import { useHandRecorder } from "./useProfile";

export default function ProfileRecorder() {
  useHandRecorder();
  return <Outlet />;
}
