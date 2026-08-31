/**
 * How well the reader's own estimates track the engine's.
 *
 * `GuessReveal` makes a reader commit a number before the computed one appears.
 * A single delta is a moment of feedback and nothing more; the useful claim is
 * the one that only shows up over a run of guesses, "your equity estimates come
 * in six points high". That claim needs a memory, and this app has no backend
 * and no accounts, so localStorage is the source of truth by design, same as
 * `tableOptions.ts`, `components/profile/store.ts` and `opponentMemory.ts`.
 *
 * WHAT IS KEPT, AND WHY IT IS NOT THE GUESSES. Three numbers per quantity:
 * how many estimates, the mean signed error, the mean absolute error. A log of
 * every guess forever would grow without bound and answer no question the pair
 * of means does not already answer: signed error is the bias (which direction
 * the reader leans), absolute error is the precision (how far off they are at
 * all), and the two together are the whole of calibration. Keeping the log
 * would also mean deciding what to trim, which is the cap below by another
 * route.
 *
 * SIGN CONVENTION, fixed here so no surface has to guess it:
 *
 *   error = guess − actual
 *
 * so a positive mean signed error means the reader habitually estimates too
 * high. For equity that reads as optimism; for a required equity it reads as
 * folding too much. Which word to use belongs to the surface printing the
 * sentence, not to the store.
 *
 * Everything read back is untrusted in the sense the other three modules mean
 * it: a hand-edited or half-written row must degrade to "nothing observed"
 * rather than throw, because the page reloads into the same stored value and a
 * throw would brick it permanently. Writes swallow quota errors: a reader in
 * private browsing still gets the delta on screen, they just do not accumulate.
 */

const STORAGE_KEY = "pp.calibration.v1";

export const CALIBRATION_VERSION = 1;

/**
 * The quantities a guess can be about.
 *
 * A closed set, because it is what makes a stored row checkable: an unknown key
 * is dropped rather than accumulated, so a typo in a call site cannot quietly
 * open a fourth bucket that no surface ever reads. A kind is added when
 * something gates a guess of that quantity, not in anticipation of one.
 *
 * `equity` and `table-equity` are the same physical quantity and deliberately
 * separate buckets. On the concepts page a reader estimates on a slider, in half
 * points, with no clock; at the table they pick a band while a hand waits, and
 * the band's width puts a floor under the absolute error that has nothing to do
 * with how well they read the spot. Pooling them would corrupt the precision
 * figure for both. The bias figure survives either way, which is why both are
 * worth keeping rather than dropping the coarser one.
 */
export const CALIBRATION_KINDS = [
  "equity",
  "table-equity",
  "required-equity",
] as const;

export type CalibrationKind = (typeof CALIBRATION_KINDS)[number];

/**
 * Estimates folded into one bucket before the mean stops growing its window.
 *
 * Past this the entry is an exponential moving average with a fifty-guess
 * horizon rather than a lifetime mean, which is both the growth cap and the
 * honest reading of the quantity: a reader who was ten points optimistic in
 * their first session and is level now is calibrated, and a lifetime mean would
 * keep telling them otherwise for hundreds of guesses.
 */
export const MAX_SAMPLES = 50;

/**
 * Ceiling on a stored error. Nothing legitimate approaches it: both kinds are
 * probabilities and the sliders are bounded, so a value past it means the row
 * was edited. Such a bucket is dropped and the others survive.
 */
const MAX_ERROR = 1e6;

export interface CalibrationEntry {
  /** Estimates folded in, capped at `MAX_SAMPLES`. */
  count: number;
  /** Mean of (guess − actual). Positive means the reader estimates high. */
  meanSignedError: number;
  /** Mean of |guess − actual|. How far off, direction discarded. */
  meanAbsError: number;
  updatedAt: number;
}

export interface CalibrationSummary {
  version: typeof CALIBRATION_VERSION;
  /** Absent means no estimate of that quantity has ever been committed. */
  byKind: Partial<Record<CalibrationKind, CalibrationEntry>>;
  updatedAt: number;
}

export function emptyCalibration(): CalibrationSummary {
  return { version: CALIBRATION_VERSION, byKind: {}, updatedAt: 0 };
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

function isKind(value: unknown): value is CalibrationKind {
  return (
    typeof value === "string" &&
    (CALIBRATION_KINDS as readonly string[]).includes(value)
  );
}

/** A finite number no larger in magnitude than `MAX_ERROR`, or null. */
function error(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_ERROR
    ? value
    : null;
}

function normalizeEntry(raw: unknown): CalibrationEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const count = r.count;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_SAMPLES
  ) {
    return null;
  }

  const signed = error(r.meanSignedError);
  const abs = error(r.meanAbsError);
  if (signed === null || abs === null || abs < 0) return null;

  // An absolute error smaller than the signed one is arithmetically impossible,
  // so the row was not written by this module.
  if (abs + 1e-9 < Math.abs(signed)) return null;

  return {
    count,
    meanSignedError: signed,
    meanAbsError: abs,
    updatedAt:
      typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt)
        ? r.updatedAt
        : 0,
  };
}

/** Clamp anything from storage back into a usable summary, or start over. */
export function normalizeCalibration(raw: unknown): CalibrationSummary {
  if (!raw || typeof raw !== "object") return emptyCalibration();
  const r = raw as Record<string, unknown>;
  if (r.version !== CALIBRATION_VERSION) return emptyCalibration();

  const byKind: Partial<Record<CalibrationKind, CalibrationEntry>> = {};
  const stored = r.byKind;
  if (stored && typeof stored === "object") {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!isKind(key)) continue;
      const entry = normalizeEntry(value);
      if (entry) byKind[key] = entry;
    }
  }

  return {
    version: CALIBRATION_VERSION,
    byKind,
    updatedAt:
      typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt)
        ? r.updatedAt
        : 0,
  };
}

/**
 * One estimate folded into an entry.
 *
 * Exact arithmetic mean until the window fills, then a moving average at the
 * same weight the last exact step used, so the sequence has no discontinuity at
 * the cap: guess fifty and guess fifty-one both move the mean by a fiftieth of
 * their distance from it.
 */
export function foldGuess(
  prev: CalibrationEntry | undefined,
  guess: number,
  actual: number,
  now = Date.now()
): CalibrationEntry {
  const delta = guess - actual;
  const base = prev ?? { count: 0, meanSignedError: 0, meanAbsError: 0, updatedAt: 0 };
  const count = Math.min(base.count + 1, MAX_SAMPLES);
  const weight = 1 / count;
  return {
    count,
    meanSignedError:
      base.meanSignedError + (delta - base.meanSignedError) * weight,
    meanAbsError:
      base.meanAbsError + (Math.abs(delta) - base.meanAbsError) * weight,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadCalibration(): CalibrationSummary {
  if (typeof window === "undefined") return emptyCalibration();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyCalibration();
    return normalizeCalibration(JSON.parse(raw));
  } catch {
    // Corrupt or unavailable storage must never block reading the page.
    return emptyCalibration();
  }
}

export function saveCalibration(summary: CalibrationSummary): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(summary));
  } catch {
    /* private browsing / quota, the calibration just will not persist */
  }
}

/**
 * Record one estimate and return the summary it produced.
 *
 * Written synchronously rather than deferred like `opponentMemory.scheduleSave`,
 * because this is three numbers on a deliberate button press, not six hundred
 * cells at the end of every hand: there is nothing to coalesce and nobody is
 * waiting on a decision. A guess whose actual value is not a finite number is
 * dropped, so a quantity the engine failed to produce cannot poison the mean.
 */
export function recordGuess(
  kind: CalibrationKind,
  guess: number,
  actual: number
): CalibrationSummary {
  const current = loadCalibration();
  if (!Number.isFinite(guess) || !Number.isFinite(actual)) return current;
  if (Math.abs(guess - actual) > MAX_ERROR) return current;

  const next: CalibrationSummary = {
    version: CALIBRATION_VERSION,
    byKind: { ...current.byKind, [kind]: foldGuess(current.byKind[kind], guess, actual) },
    updatedAt: Date.now(),
  };
  saveCalibration(next);
  return next;
}

/** The rolling entry for one quantity, or null if nothing has been guessed. */
export function calibrationFor(
  kind: CalibrationKind,
  summary = loadCalibration()
): CalibrationEntry | null {
  return summary.byKind[kind] ?? null;
}

/** Forget everything and clear the stored copy. */
export function clearCalibration(): CalibrationSummary {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to do */
    }
  }
  return emptyCalibration();
}
