// @vitest-environment jsdom
/**
 * What a chair says about who is sitting in it.
 *
 * This exists for one defect. The opponent skins used `profile === null` to mean
 * "this is the human" and fell back to a "YOU" monogram, which was true while
 * every bot had a static roster row. `mirror` broke that: its parameters are
 * measured from a played session, so a bot seat can legitimately have no
 * profile, and a mirrored seat at a table with no measured style sat on the felt
 * wearing the player's own mark.
 *
 * The invariant is narrow and worth pinning exactly: an opponent chip never
 * shows the human's monogram, whatever its profile resolves to.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SeatView, type SeatViewProps } from "./Seat";
import { BOT_PROFILES } from "../../poker/model/profiles";
import type { TableSeat } from "../../poker/table/state";
import type { BotProfile } from "../../poker/table/contract";

function tableSeat(over: Partial<TableSeat> = {}): TableSeat {
  return {
    id: 1,
    name: "Tight Aggressive",
    kind: "bot",
    profile: "tag",
    stack: 1000,
    hole: [],
    status: "active",
    streetCommit: 0,
    invested: 0,
    acted: false,
    ...over,
  } as TableSeat;
}

function props(over: Partial<SeatViewProps> = {}): SeatViewProps {
  return {
    seat: tableSeat(),
    point: { x: 50, y: 20 },
    position: "BB",
    profile: BOT_PROFILES.tag,
    active: false,
    reveal: false,
    hero: false,
    compact: false,
    fx: { bubble: null, thinking: null },
    read: null,
    won: null,
    net: null,
    settled: false,
    showBlurb: false,
    bigBlind: 10,
    ...over,
  };
}

const monograms = () =>
  [...document.querySelectorAll(".pp-avatar")].map((e) => e.textContent?.trim());

/**
 * jsdom implements no `matchMedia`, and the hero skin reads one through
 * `useNarrow`. Stubbed as a wide viewport, which is the case these tests are
 * about: the compact path is exercised by passing `compact` explicitly rather
 * than by pretending to be a phone.
 */
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

describe("an opponent chip", () => {
  it("shows the profile's monogram when there is one", () => {
    render(<SeatView {...props()} />);
    expect(monograms()).toContain("TAG");
  });

  it("never shows the human's monogram when the profile is unresolvable", () => {
    // The mirrored-seat defect. A bot with no profile is playing the pure-EV
    // baseline, so it is marked for that, not for the player.
    render(
      <SeatView
        {...props({
          profile: null,
          seat: tableSeat({ profile: "mirror", name: "Expected Value Baseline" }),
        })}
      />
    );
    const marks = monograms();
    expect(marks).not.toContain("YOU");
    expect(marks).toContain("EV");
  });

  it("holds on the compact skin too, which is a separate render path", () => {
    render(
      <SeatView
        {...props({
          compact: true,
          profile: null,
          seat: tableSeat({ profile: "mirror" }),
        })}
      />
    );
    const marks = monograms();
    expect(marks).not.toContain("YOU");
    expect(marks).toContain("EV");
  });

  it("shows a resolved mirror's own monogram, not the baseline's", () => {
    const mirror: BotProfile = {
      ...BOT_PROFILES.tag,
      id: "mirror" as BotProfile["id"],
      name: "Mirror",
      short: "Mirror",
      monogram: "ME",
    };
    render(<SeatView {...props({ profile: mirror, seat: tableSeat({ profile: "mirror" }) })} />);
    const marks = monograms();
    expect(marks).toContain("ME");
    expect(marks).not.toContain("YOU");
    expect(marks).not.toContain("EV");
  });
});

describe("the hero's own chair", () => {
  it("draws no monogram, because the name beside it already says You", () => {
    // "YOU You" was on screen before this.
    render(
      <SeatView
        {...props({
          hero: true,
          profile: null,
          seat: tableSeat({ id: 0, kind: "human", name: "You", profile: undefined }),
        })}
      />
    );
    expect(monograms()).toHaveLength(0);
    expect(screen.getByText("You")).toBeTruthy();
  });
});
