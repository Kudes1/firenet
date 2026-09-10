import { describe, expect, it } from "vitest";
import { cloudPath } from "./cloud";

describe("cloudPath", () => {
  // Контур облака: замкнутый путь из квадратичных сегментов вокруг bbox.
  it("returns a closed path within the bbox plus bump depth", () => {
    const d = cloudPath(0, 0, 160, 60);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    const xs = [...d.matchAll(/[MLQ]\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const ys = [...d.matchAll(/[MLQ][\s-]*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)].map((m) => Number(m[2]));
    expect(Math.min(...xs)).toBeLessThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(166 + 1);
    expect(Math.min(...ys)).toBeLessThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(66 + 1);
  });

  it("has outward bumps on the perimeter (many quadratic segments)", () => {
    const d = cloudPath(0, 0, 160, 60);
    expect(d.split("Q").length - 1).toBeGreaterThanOrEqual(18);
  });

  it("is stable for the same input", () => {
    expect(cloudPath(0, 0, 160, 60)).toBe(cloudPath(0, 0, 160, 60));
  });
});
