import { describe, expect, it } from "vitest";
import {
  containsFold, ipv4CidrOverlap, matchPrefixQuery, matchSubnetMembers, parseQueryPrefix,
} from "./search";

describe("containsFold", () => {
  it("matches case-insensitively and treats missing as empty", () => {
    expect(containsFold("Office", "fic")).toBe(true);
    expect(containsFold(undefined, "x")).toBe(false);
    expect(containsFold("a", "")).toBe(true);
  });
});

describe("parseQueryPrefix", () => {
  it("completes a bare IP to /32", () => {
    expect(parseQueryPrefix("10.0.0.5")).toEqual({ addr: "10.0.0.5", bits: 32 });
  });
  it("reads an explicit CIDR", () => {
    expect(parseQueryPrefix("10.0.0.0/24")).toEqual({ addr: "10.0.0.0", bits: 24 });
  });
  it("turns a partial address into a prefix", () => {
    expect(parseQueryPrefix("10.0.")).toEqual({ addr: "10.0.0.0", bits: 16 });
    expect(parseQueryPrefix("10.0")).toEqual({ addr: "10.0.0.0", bits: 16 });
    expect(parseQueryPrefix("10.0.0")).toEqual({ addr: "10.0.0.0", bits: 24 });
  });
  it("rejects octets over 255 and leading zeros in partials", () => {
    expect(parseQueryPrefix("999.")).toBeNull();
    expect(parseQueryPrefix("010.0.")).toBeNull();
  });
  it("returns null for non-addresses", () => {
    expect(parseQueryPrefix("lan")).toBeNull();
  });
});

describe("matchPrefixQuery", () => {
  it("matches containing prefixes at /32 and overlapping below", () => {
    expect(matchPrefixQuery("10.0.0.5/32", "10.0.0.0/24")).toBe(true);
    expect(matchPrefixQuery("10.0.0.0/24", "10.0.1.0/24")).toBe(false);
  });
  it("falls back to a case-insensitive substring for names", () => {
    expect(matchPrefixQuery("lan", "LAN")).toBe(true);
  });
});

describe("matchSubnetMembers", () => {
  const cidrOf = (n: string) => (n === "lan" ? "10.0.0.0/24" : "192.168.0.0/24");
  it("matches by member name or CIDR", () => {
    expect(matchSubnetMembers(["lan"], cidrOf, "10.0.0")).toBe(true);
    expect(matchSubnetMembers(["lan"], cidrOf, "192.168")).toBe(false);
  });
});

describe("ipv4CidrOverlap", () => {
  it("detects overlapping blocks and ignores disjoint ones", () => {
    expect(ipv4CidrOverlap("10.0.0.0/24", "10.0.0.128/25")).toBe(true);
    expect(ipv4CidrOverlap("10.0.0.0/24", "10.0.1.0/24")).toBe(false);
  });
});
