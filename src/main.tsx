import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { NeonAuthUIProvider, authClient, authConfigured } from "./lib/auth.ts";
import { flushNow, sync } from "./lib/api.ts";

/**
 * Resume the write-behind queue when the tab comes back.
 *
 * A queue that only drains while a hand is being played would sit on a failed
 * upload until the next hand — which, on the profile page or after closing the
 * laptop, may be never. These are the two moments the browser tells us the
 * network is worth trying again, and both are free.
 */
function SyncResume({ children }: { children: ReactNode }) {
  useEffect(() => {
    const retry = () => {
      if (sync.getSession()) void flushNow();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return children;
}

function AuthGate({ children }: { children: ReactNode }) {
  // Without an auth service there is no provider to mount and nothing to sign
  // into — the app runs exactly as it always has, on localStorage alone.
  if (!authConfigured) return children;
  return (
    <NeonAuthUIProvider authClient={authClient}>{children}</NeonAuthUIProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <SyncResume>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SyncResume>
    </AuthGate>
  </StrictMode>
);
