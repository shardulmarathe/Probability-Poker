import { describe, expect, it } from "vitest";
import {
  actingOrder,
  blindSeats,
  firstToAct,
  oddChipOrder,
  positionOf,
  seatsFrom,
} from "./position";
import type { Street } from "../../types";

const POSTFLOP: Street[] = ["flop", "turn", "river"];

describe("blindSeats", () => {
  it("makes the button the small blind heads-up", () => {
    // The heads-up rule people get wrong: the button posts the SMALL blind.
    expect(blindSeats(0, 2)).toEqual({ sb: 0, bb: 1 });
    expect(blindSeats(1, 2)).toEqual({ sb: 1, bb: 0 });
  });

  it("puts the blinds left of the button with three or more", () => {
    expect(blindSeats(0, 3)).toEqual({ sb: 1, bb: 2 });
    expect(blindSeats(2, 4)).toEqual({ sb: 3, bb: 0 });
    expect(blindSeats(5, 6)).toEqual({ sb: 0, bb: 1 });
  });
});

describe("positionOf", () => {
  it("labels the button and blinds", () => {
    expect(positionOf(0, 0, 4)).toBe("BTN");
    expect(positionOf(1, 0, 4)).toBe("SB");
    expect(positionOf(2, 0, 4)).toBe("BB");
  });

  it("has no separate SB seat heads-up", () => {
    // The button IS the small blind, so only BTN and BB exist.
    expect(positionOf(0, 0, 2)).toBe("BTN");
    expect(positionOf(1, 0, 2)).toBe("BB");
  });

  it("rotates with the button", () => {
    expect(positionOf(3, 3, 6)).toBe("BTN");
    expect(positionOf(4, 3, 6)).toBe("SB");
    expect(positionOf(2, 3, 6)).toBe("CO");
  });

  it("assigns every seat a distinct position at every table size", () => {
    for (let n = 2; n <= 6; n++) {
      for (let button = 0; button < n; button++) {
        const labels = Array.from({ length: n }, (_, s) => positionOf(s, button, n));
        expect(new Set(labels).size).toBe(n);
      }
    }
  });

  it("rejects unsupported table sizes", () => {
    expect(() => positionOf(0, 0, 1)).toThrow(/unsupported table size/);
    expect(() => positionOf(0, 0, 9)).toThrow(/unsupported table size/);
  });
});

describe("firstToAct", () => {
  it("has the button act first preflop and last after, heads-up", () => {
    expect(firstToAct("preflop", 0, 2)).toBe(0);
    for (const s of POSTFLOP) expect(firstToAct(s, 0, 2)).toBe(1);
  });

  it("starts preflop action left of the big blind", () => {
    expect(firstToAct("preflop", 0, 4)).toBe(3); // BB is seat 2
    expect(firstToAct("preflop", 0, 6)).toBe(3);
  });

  it("wraps to the button three-handed, where UTG is the button", () => {
    expect(firstToAct("preflop", 0, 3)).toBe(0);
  });

  it("starts postflop action at the small blind", () => {
    for (const s of POSTFLOP) {
      expect(firstToAct(s, 0, 4)).toBe(1);
      expect(firstToAct(s, 2, 4)).toBe(3);
    }
  });
});

describe("actingOrder", () => {
  it("gives the big blind the option preflop at every size", () => {
    for (let n = 2; n <= 6; n++) {
      for (let button = 0; button < n; button++) {
        const { bb } = blindSeats(button, n);
        const order = actingOrder("preflop", button, n);
        expect(order).toHaveLength(n);
        expect(order[order.length - 1]).toBe(bb);
      }
    }
  });

  it("lets the button close the action on every later street", () => {
    for (let n = 2; n <= 6; n++) {
      for (let button = 0; button < n; button++) {
        for (const s of POSTFLOP) {
          expect(actingOrder(s, button, n).at(-1)).toBe(button);
        }
      }
    }
  });

  it("is a clockwise permutation of every seat", () => {
    for (let n = 2; n <= 6; n++) {
      for (const s of ["preflop", ...POSTFLOP] as Street[]) {
        const order = actingOrder(s, 1, n);
        expect([...order].sort((a, b) => a - b)).toEqual(
          Array.from({ length: n }, (_, i) => i)
        );
        for (let i = 1; i < order.length; i++) {
          expect(order[i]).toBe((order[i - 1] + 1) % n);
        }
      }
    }
  });

  it("moves the blinds to acting last preflop and first after", () => {
    // The positional swing that makes preflop and postflop order differ.
    const button = 0, n = 6;
    const { sb, bb } = blindSeats(button, n);
    const pre = actingOrder("preflop", button, n);
    const post = actingOrder("flop", button, n);
    expect(pre.indexOf(sb)).toBeGreaterThan(pre.indexOf(button));
    expect(post.indexOf(sb)).toBeLessThan(post.indexOf(button));
    expect(pre.at(-1)).toBe(bb);
    expect(post[0]).toBe(sb);
  });
});

describe("oddChipOrder", () => {
  it("starts left of the button", () => {
    expect(oddChipOrder(0, 4)).toEqual([1, 2, 3, 0]);
    expect(oddChipOrder(3, 4)).toEqual([0, 1, 2, 3]);
  });

  it("covers every seat exactly once", () => {
    for (let n = 2; n <= 6; n++) {
      expect(new Set(oddChipOrder(1, n)).size).toBe(n);
    }
  });
});

describe("seatsFrom", () => {
  it("wraps clockwise", () => {
    expect(seatsFrom(2, 4)).toEqual([2, 3, 0, 1]);
    expect(seatsFrom(0, 2)).toEqual([0, 1]);
  });
});
