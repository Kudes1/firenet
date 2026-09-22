import { describe, expect, it } from "vitest";
import { parseHostAddress, parseRuleLiteral, uniqueNameHint, validPortSpec } from "./validate";

describe("uniqueNameHint", () => {
  const names = ["lan", "dmz"];
  it("accepts a free name", () => expect(uniqueNameHint("wan", names)).toBe(""));
  it("rejects a duplicate", () => expect(uniqueNameHint("lan", names)).toBe("Имя уже используется"));
  it("allows the object to keep its own name", () => expect(uniqueNameHint("lan", names, 0)).toBe(""));
  it("rejects empty", () => expect(uniqueNameHint("  ", names)).toBe("Имя обязательно"));
  it("accepts spaces, dots, colons and cyrillic", () => {
    expect(uniqueNameHint("Офис LAN", names)).toBe("");
    expect(uniqueNameHint("r.1", names)).toBe("");
  });
  it("rejects pipe and hash", () => {
    expect(uniqueNameHint("sw|core", names)).toBe("Недопустимые символы в имени: | #");
    expect(uniqueNameHint("sw#2", names)).toBe("Недопустимые символы в имени: | #");
  });
});

describe("parseHostAddress", () => {
  it("accepts a bare IPv4 as /32", () => expect(parseHostAddress("10.0.0.5")).toBe("10.0.0.5/32"));
  it("accepts an explicit /32 and rejects shorter v4 masks", () => {
    expect(parseHostAddress("10.0.0.5/32")).toBe("10.0.0.5/32");
    expect(parseHostAddress("10.0.0.0/24")).toBeNull();
  });
  it("accepts IPv6 only as /128", () => {
    expect(parseHostAddress("2001:db8::1/128")).toBe("2001:db8::1/128");
    expect(parseHostAddress("2001:db8::1")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(parseHostAddress("office")).toBeNull();
    expect(parseHostAddress("10.0.0.5/32/1")).toBeNull();
  });
});

describe("parseRuleLiteral", () => {
  it("accepts a bare IPv4 as /32", () => expect(parseRuleLiteral("10.0.0.5")).toBe("10.0.0.5/32"));
  it("accepts an IPv4 CIDR and masks it", () => {
    expect(parseRuleLiteral("10.0.0.0/24")).toBe("10.0.0.0/24");
    expect(parseRuleLiteral("10.0.0.5/24")).toBe("10.0.0.0/24");
  });
  it("rejects IPv6, bad octets and names", () => {
    expect(parseRuleLiteral("2001:db8::1")).toBeNull();
    expect(parseRuleLiteral("10.0.0.999")).toBeNull();
    expect(parseRuleLiteral("10.0.0.0/33")).toBeNull();
    expect(parseRuleLiteral("office")).toBeNull();
    expect(parseRuleLiteral("")).toBeNull();
  });
});

describe("validPortSpec", () => {
  it("accepts single ports and ranges", () => {
    expect(validPortSpec("80")).toBe(true);
    expect(validPortSpec("1024-2048")).toBe(true);
  });
  it("rejects bad numbers, reversed ranges and junk", () => {
    expect(validPortSpec("0")).toBe(false);
    expect(validPortSpec("70000")).toBe(false);
    expect(validPortSpec("2048-1024")).toBe(false);
    expect(validPortSpec("80,abc")).toBe(false);
  });
});
