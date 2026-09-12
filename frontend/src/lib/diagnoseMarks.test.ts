import { describe, expect, it } from "vitest";
import type { MapMark } from "../api/types";
import { diagnosticMarkOf } from "./diagnoseMarks";

const mark = (overrides: Partial<MapMark> = {}): MapMark => ({
  hl: [], ok: [], okE: [], denyE: [], half: [], halfE: [], deny: {}, ...overrides,
});

describe("diagnosticMarkOf", () => {
  it("marks highlighted nodes and dims objects outside the path", () => {
    const markOf = diagnosticMarkOf(mark({
      hl: ["office", "r1", "sw1"],
      ok: ["office", "r1", "sw1"],
    }));

    expect(markOf("network:office")).toBe("diag-flow-ok");
    expect(markOf("device:r1")).toBe("diag-flow-ok");
    expect(markOf("device:isolated")).toBe("diag-dim");
    expect(markOf("union:cluster")).toBe("diag-dim");
  });

  it("marks links and attachments from endpoint keys", () => {
    const markOf = diagnosticMarkOf(mark({
      hl: ["office", "r1", "sw1"],
      okE: ["r1\0sw1", "office\0sw1"],
    }));

    expect(markOf("link:r1|sw1#0")).toBe("diag-flow-ok");
    expect(markOf("attach:office|sw1")).toBe("diag-flow-ok");
    expect(markOf("link:r1|isolated#0")).toBe("diag-dim");
  });

  it("prioritizes denied flow over half and allowed flow", () => {
    const markOf = diagnosticMarkOf(mark({
      hl: ["office", "r1", "sw1"],
      ok: ["r1", "sw1"],
      half: ["r1", "sw1"],
      deny: { r1: { rule: "deny-r1", reason: "blocked" } },
      okE: ["r1\0sw1"],
      halfE: ["r1\0sw1", "office\0sw1"],
      denyE: ["r1\0sw1"],
    }));

    expect(markOf("device:r1")).toBe("diag-flow-deny");
    expect(markOf("device:sw1")).toBe("diag-flow-half");
    expect(markOf("link:r1|sw1#0")).toBe("diag-flow-deny");
    expect(markOf("attach:office|sw1")).toBe("diag-flow-half");
  });

  it("returns no diagnostic class without a result", () => {
    expect(diagnosticMarkOf(undefined)("device:r1")).toBeUndefined();
  });
});
