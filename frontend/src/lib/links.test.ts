import { describe, expect, it } from "vitest";
import { canonicalLink, layoutLinkKey } from "./links";

describe("canonicalLink", () => {
  it("orders the pair lexicographically", () => {
    expect(canonicalLink("r1", "sw1")).toEqual(["r1", "sw1"]);
    expect(canonicalLink("sw1", "r1")).toEqual(["r1", "sw1"]);
  });
});

describe("layoutLinkKey", () => {
  it('is "min(a,b)|max(a,b)"', () => {
    expect(layoutLinkKey("sw1", "r1")).toBe("r1|sw1");
    expect(layoutLinkKey("r1", "sw1")).toBe("r1|sw1");
  });
});
