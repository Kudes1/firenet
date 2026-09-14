import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, initialTheme, initializeTheme } from "./theme";

const index = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const earlyThemeSource = index.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function runEarlyThemeBootstrap() {
  if (!earlyThemeSource) throw new Error("early theme bootstrap not found");
  Function(earlyThemeSource)();
}

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

  it("defaults to light when an invalid preference was saved", () => {
    localStorage.setItem("ui.theme", "system");
    expect(initialTheme()).toBe("light");
  });

  it.each([
    { saved: null, expected: "light" },
    { saved: "system", expected: "light" },
    { saved: "dark", expected: "dark" },
  ])("initializes the document to $expected for saved value $saved", ({ saved, expected }) => {
    if (saved !== null) localStorage.setItem("ui.theme", saved);
    initializeTheme();
    expect(document.documentElement.dataset.theme).toBe(expected);
    expect(localStorage.getItem("ui.theme")).toBe(saved);
  });

  it.each([
    { saved: null, expected: "light" },
    { saved: "system", expected: "light" },
    { saved: "dark", expected: "dark" },
  ])("sets the early document theme to $expected for saved value $saved", ({ saved, expected }) => {
    if (saved !== null) localStorage.setItem("ui.theme", saved);
    runEarlyThemeBootstrap();
    expect(document.documentElement.dataset.theme).toBe(expected);
  });

  it("applies and persists the selected theme", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ui.theme")).toBe("dark");
  });
});
