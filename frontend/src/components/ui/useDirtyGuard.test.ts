import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDirtyGuard } from "./useDirtyGuard";

describe("useDirtyGuard", () => {
  it("is clean right after arming", () => {
    const data = { a: 1 };
    const { result } = renderHook(() => useDirtyGuard(() => data));
    expect(result.current.isDirty()).toBe(false);
  });

  it("becomes dirty once the document changes and clean after markClean", () => {
    const data = { a: 1 };
    const { result } = renderHook(() => useDirtyGuard(() => data));
    data.a = 2;
    expect(result.current.isDirty()).toBe(true);
    result.current.markClean();
    expect(result.current.isDirty()).toBe(false);
  });

  it("blocks unload while dirty", () => {
    const data = { a: 1 };
    renderHook(() => useDirtyGuard(() => data));
    data.a = 2;
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
