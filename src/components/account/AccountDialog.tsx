/**
 * Sign in / sign up, in a modal over the felt.
 *
 * Deliberately *not* a route, and deliberately dismissible with Escape, a
 * backdrop click, and a "Keep playing locally" button that is as prominent as
 * the submit. There is no login wall anywhere in this product, the dialog is
 * an offer, and it says out loud what accepting it changes and what it does
 * not.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { signIn, signUp } from "../../lib/auth";
import { BUTTON, FIELD, LABEL, LINE, SURFACE } from "./skin";

type Mode = "signin" | "signup";

export function AccountDialog({
  open,
  onClose,
  initialMode = "signin",
}: {
  open: boolean;
  onClose: () => void;
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setError(null);
    // Focus lands in the form rather than on the close button: the dialog was
    // opened on purpose, so the next keystroke is almost certainly an email.
    const t = setTimeout(() => firstField.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open, initialMode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  /*
   * Portalled to `document.body` on purpose. This dialog is opened from a
   * control that lives inside the sticky header, and that header uses
   * `backdrop-filter`. A filter on an ancestor becomes the containing block
   * for `position: fixed`, so a modal rendered in-tree is trapped in the
   * 52px header: the email field is clipped off the top of the viewport and
   * the form is unusable. The body has no such ancestor.
   */

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result =
      mode === "signin"
        ? await signIn(email.trim(), password)
        : await signUp(name.trim() || email.trim(), email.trim(), password);
    setBusy(false);
    if (result.ok) {
      setPassword("");
      onClose();
      return;
    }
    setError(result.error ?? "That did not work. Try again.");
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: "rgba(3,8,6,0.72)", backdropFilter: "blur(6px)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[24rem] rounded-2xl p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
        style={{ background: SURFACE.panel, border: `1px solid ${LINE.gold}` }}
      >
        <h2
          id={titleId}
          className="font-display text-lg tracking-wide text-gold-soft"
        >
          {mode === "signin" ? "Sign in" : "Create an account"}
        </h2>
        <p className="mt-1.5 text-[0.72rem] leading-relaxed text-ivory/45">
          Optional. Your hands are already saved in this browser — an account
          adds a copy you can reach from another device.
        </p>

        <form onSubmit={submit} className="mt-5 space-y-3.5">
          {mode === "signup" && (
            <div>
              <label className={LABEL} htmlFor={`${titleId}-name`}>
                Display name
              </label>
              <input
                id={`${titleId}-name`}
                ref={mode === "signup" ? firstField : undefined}
                className={FIELD}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="nickname"
                placeholder="Shown on the leaderboard"
              />
            </div>
          )}

          <div>
            <label className={LABEL} htmlFor={`${titleId}-email`}>
              Email
            </label>
            <input
              id={`${titleId}-email`}
              ref={mode === "signin" ? firstField : undefined}
              className={FIELD}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor={`${titleId}-password`}>
              Password
            </label>
            <input
              id={`${titleId}-password`}
              className={FIELD}
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
            />
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-lg px-3 py-2 text-[0.72rem] leading-relaxed"
              style={{
                background: "rgba(122,0,25,0.22)",
                border: "1px solid rgba(163,2,34,0.45)",
                color: "#f0c9cd",
              }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className={`${BUTTON.base} ${BUTTON.primary} min-h-[42px] w-full px-5 py-2.5 text-sm`}
          >
            {busy
              ? "One moment…"
              : mode === "signin"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        <div
          className="mt-4 flex items-center justify-between gap-3 border-t pt-4"
          style={{ borderColor: LINE.quiet }}
        >
          <button
            type="button"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
            }}
            className="font-display text-[0.66rem] uppercase tracking-[0.18em] text-gold-soft/70 transition hover:text-gold-soft"
          >
            {mode === "signin" ? "Create an account" : "I have an account"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="font-display text-[0.66rem] uppercase tracking-[0.18em] text-ivory/40 transition hover:text-ivory/70"
          >
            Keep playing locally
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
