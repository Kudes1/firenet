import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, initialTheme } from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
  });
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    vi.unstubAllGlobals();
  });

  it("defaults to light when no preference was saved", () => {
    expect(initialTheme()).toBe("light");
  });

  it("keeps a saved dark preference", () => {
    localStorage.setItem("ui.theme", "dark");
    expect(initialTheme()).toBe("dark");
  });

  it("applies and persists the selected theme", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ui.theme")).toBe("dark");
  });
});
