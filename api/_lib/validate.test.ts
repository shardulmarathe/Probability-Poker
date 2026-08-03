/**
 * Every id that arrives in a request is interpolated as `${id}::uuid`, and
 * Postgres raises `invalid input syntax for type uuid` on anything that is not
 * one. That threw past the `HttpError` branch in `sendError` and answered 500 —
 * a server error, for a request the client got wrong. It never leaked, but it
 * told the caller to retry something that can never succeed and would page
 * whoever watches the 5xx rate.
 *
 * Needs no database, so it runs on every `npm run test:api`, unlike the
 * two-user scoping suite beside it.
 */
import { describe, expect, it } from "vitest";
import { HttpError, requireUuid } from "./auth.js";

const VALID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("requireUuid", () => {
  it("returns a well-formed uuid unchanged", () => {
    expect(requireUuid(VALID, "Hand id")).toBe(VALID);
    expect(requireUuid(VALID.toUpperCase(), "Hand id")).toBe(VALID.toUpperCase());
  });

  it("rejects everything a client might actually send, as a 400", () => {
    const bad: unknown[] = [
      "not-a-uuid",
      "",
      // The shape is right and the characters are not.
      "3f2504e0-4f89-41d3-9a0c-0305e82c330g",
      // One character short, which a truncating client produces.
      "3f2504e0-4f89-41d3-9a0c-0305e82c330",
      // A SQL fragment, which is the reason this is a whitelist and not a
      // blacklist — the driver parameterises, but the cast still has to hold.
      `${VALID}'; drop table hands; --`,
      undefined,
      null,
      42,
      VALID.split("-"),
      { id: VALID },
    ];
    for (const value of bad) {
      let caught: unknown;
      try {
        requireUuid(value, "Hand id");
      } catch (err) {
        caught = err;
      }
      expect(caught, `${JSON.stringify(value)} should have been rejected`).toBeInstanceOf(
        HttpError
      );
      expect((caught as HttpError).status).toBe(400);
    }
  });

  it("names the field it rejected, so the client can tell which one", () => {
    expect(() => requireUuid("nope", "sessionId")).toThrow(/sessionId/);
  });
});
