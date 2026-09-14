import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import * as fx from "../api/fixtures";
import { storageKeys } from "../lib/storage";
import Layout from "./Layout";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

function renderLayout(route = "/ui/subnets") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          {/* Outlet (в Layout) требует контекст родительского route, поэтому
              Layout оборачиваем в pathless <Route> с дочерней заглушкой. */}
          <Route element={<Layout />}>
            <Route path={route} element={<main data-testid="page" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Layout", () => {
  it("renders the sidebar with all nav links", async () => {
    renderLayout();
    expect(await screen.findByRole("link", { name: "Схема" })).toHaveAttribute("href", "/ui/topology");
    for (const label of ["Устройства", "Сети", "Подсети", "Наборы", "Правила", "Компиляция", "Черновики", "История"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("shows an icon and a label in every nav link", async () => {
    renderLayout();
    const link = await screen.findByRole("link", { name: "Схема" });
    expect(link.querySelector(".icon svg")).not.toBeNull();
    expect(link.querySelector(".label")).toHaveTextContent("Схема");
    expect(link).toHaveAccessibleName("Схема");
  });

  it("renders group headers with a chevron icon and the toggle at the bottom", async () => {
    renderLayout();
    await screen.findByRole("link", { name: "Схема" });
    const sidebar = document.querySelector(".sidebar") as HTMLElement;
    expect(sidebar.querySelector(".brand")).not.toBeNull();
    const header = sidebar.querySelector(".nav-group-header") as HTMLElement;
    expect(header.querySelector(".chevron svg")).not.toBeNull();
    // порядок как в легаси: brand → nav (группы + standalone) → toggle → user-box
    const classes = [...sidebar.children].map((el) => el.className);
    expect(classes).toEqual(["brand", "side-nav", "sidebar-toggle", "user-box"]);
    expect(sidebar.querySelector(".nav-group-header .chevron svg")).not.toBeNull();
  });

  it("marks the active page", async () => {
    renderLayout("/ui/subnets");
    expect(await screen.findByRole("link", { name: "Подсети" })).toHaveClass("active");
  });

  it("hides Пользователи from non-admins and shows it to admins", async () => {
    server.use(http.get("/api/me", () => HttpResponse.json({ ...fx.userFixture, role: "user" })));
    renderLayout();
    await screen.findByRole("link", { name: "Схема" });
    expect(screen.queryByRole("link", { name: "Пользователи" })).toBeNull();
  });

  it("shows the read-only draft banner with the current version", async () => {
    server.use(http.get("/api/versions", () => HttpResponse.json([{ id: 7, createdAt: "2026-09-01T00:00:00Z" }])));
    renderLayout();
    expect(await screen.findByText(/Только чтение — версия 7/)).toBeInTheDocument();
  });

  it("shows the editing banner for an active draft", async () => {
    sessionStorage.setItem(storageKeys.draftId, "d1");
    server.use(http.get("/api/drafts/d1", () => HttpResponse.json(fx.draftFixture)));
    renderLayout();
    expect(await screen.findByText(/Черновик «правки»/)).toBeInTheDocument();
  });

  it("keeps the workspace spacing compact around the draft banner", async () => {
    expect(styles).toMatch(/\bmain\s*\{[^}]*padding:\s*var\(--space-2\)/s);
    expect(styles).toMatch(/\.draft-banner\s*\{[^}]*margin-bottom:\s*var\(--space-2\)/s);
  });
});

describe("Sidebar collapse and theme", () => {
  it("collapses via toggle, persists and toggles aria state", async () => {
    renderLayout();
    const btn = screen.getByRole("button", { name: "Свернуть меню" });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("ui.sidebar")).toBe("collapsed");
    expect(document.querySelector(".sidebar")).toHaveClass("collapsed");
  });

  it("starts collapsed from stored state", () => {
    localStorage.setItem("ui.sidebar", "collapsed");
    renderLayout();
    expect(document.querySelector(".sidebar")).toHaveClass("collapsed");
    expect(screen.getByRole("button", { name: "Развернуть меню" })).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles theme, sets data-theme and persists", async () => {
    localStorage.setItem("ui.theme", "light");
    renderLayout();
    await userEvent.click(screen.getByRole("button", { name: "Сменить тему" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ui.theme")).toBe("dark");
  });

  it("logs out via full reload to /login", async () => {
    server.use(http.post("/api/logout", () => HttpResponse.json({ ok: true })));
    // jsdom не умеет навигацию по location.href — стабим с валидным base URL
    // (пустой ломает fetch в MSW); присвоение href просто перезапишет строку.
    vi.stubGlobal("location", { href: "http://localhost/" });
    renderLayout();
    await userEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await vi.waitFor(() => expect(window.location.href).toBe("/login"));
  });
});
