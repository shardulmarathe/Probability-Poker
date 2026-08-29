/**
 * The demo has to earn its own headline.
 *
 * It exists to show a visitor that the bots learn, so the one thing worth
 * asserting is that sixty hands actually move the read. A demo that ran, said
 * "P(bet | air) 0.136 -> 0.136" and dropped the reader into an empty profile
 * would be worse than not shipping it: it would disprove the claim on the
 * landing page using the product's own engine.
 */

import { describe, expect, it } from "vitest";
import { DEMO_HANDS, runBlufferDemo } from "./demoSession";

describe("the bluffer demo", () => {
  it("moves P(bet | air) well above the shared prior", async () => {
    const result = await runBlufferDemo();

    expect(result.reports).toHaveLength(DEMO_HANDS);
    expect(result.after).toBeGreaterThan(result.before + 0.1);
    // Enough recorded decisions for the profile it lands in to say something.
    expect(result.stats.hands).toBe(DEMO_HANDS);
    expect(result.stats.observations).toBeGreaterThan(DEMO_HANDS);
  }, 60_000);

  it("reports progress and finishes on the last hand", async () => {
    const seen: number[] = [];
    await runBlufferDemo((played) => seen.push(played), 8);
    expect(seen.at(-1)).toBe(8);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  }, 60_000);
});
