import { beforeEach, describe, expect, it } from "vitest";
import { getRevision, resetRevision, revisionHeaders, setRevision } from "./revision";

describe("revision", () => {
  beforeEach(() => resetRevision());

  it("starts empty and returns no headers", () => {
    expect(getRevision()).toBeNull();
    expect(revisionHeaders()).toEqual({});
  });

  it("returns the CAS header once known", () => {
    setRevision("7");
    expect(revisionHeaders()).toEqual({ "X-Draft-Revision": "7" });
  });

  it("is reset when the draft changes", () => {
    setRevision("7");
    resetRevision();
    expect(getRevision()).toBeNull();
  });
});
