import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { NeonAuthUIProvider, authClient } from "./lib/auth.ts";

const authConfigured = Boolean(
  (import.meta.env.VITE_NEON_AUTH_URL as string | undefined)?.trim()
);

function AuthGate({ children }: { children: ReactNode }) {
  if (!authConfigured) return children;
  return (
    <NeonAuthUIProvider authClient={authClient}>{children}</NeonAuthUIProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthGate>
  </StrictMode>
);
