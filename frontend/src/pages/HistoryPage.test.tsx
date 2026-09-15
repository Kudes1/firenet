import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import HistoryPage from "./HistoryPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

const VERSIONS = [
  { id: 3, createdAt: "2026-09-03T10:00:00Z", confirmedBy: "admin" },
  { id: 2, createdAt: "2026-09-02T10:00:00Z", confirmedBy: "admin" },
  { id: 1, createdAt: "2026-09-01T10:00:00Z" },
];

describe("HistoryPage", () => {
  it("uses the shared table surface and filters versions", async () => {
    server.use(http.get("/api/versions", () => HttpResponse.json([
      { ...VERSIONS[0], note: "релиз", confirmedBy: "operator" },
      { ...VERSIONS[1], note: "черновая проверка" },
    ])));
    const { user } = renderPage(<HistoryPage />, "/ui/history");

    expect(await screen.findByTestId("page-history")).toHaveClass("history-page");
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "История версий" })).toBeInTheDocument();
    expect(screen.getByTestId("data-table")).toHaveAttribute("id", "history-table");
    expect(screen.getByRole("button", { name: "Сбросить ширины колонок" })).toBeInTheDocument();
    expect(screen.getByTitle("Дифф версии 3")).toHaveClass("secondary");
    expect(screen.getByTitle("Восстановить версию 3")).toHaveClass("primary");

    await user.click(screen.getByRole("button", { name: "Открыть поиск" }));
    await user.type(screen.getByPlaceholderText("Заметка"), "релиз");

    expect(screen.getByText("релиз")).toBeInTheDocument();
    expect(screen.queryByText("черновая проверка")).not.toBeInTheDocument();
  });

  it("lists versions newest first", async () => {
    server.use(http.get("/api/versions", () => HttpResponse.json(VERSIONS)));
    renderPage(<HistoryPage />, "/ui/history");
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows the diff against the previous version", async () => {
    server.use(
      http.get("/api/versions", () => HttpResponse.json(VERSIONS)),
      http.get("/api/versions/diff", () => HttpResponse.json([
        { kind: "device", key: "r1", change: "added", after: { name: "r1", kind: "router" } },
      ])),
    );
    const { user } = renderPage(<HistoryPage />, "/ui/history");
    await screen.findByText("3");
    await user.click(screen.getByTitle("Дифф версии 3"));
    expect(await screen.findByText("добавлено")).toBeInTheDocument();
    expect(screen.getByText("r1")).toBeInTheDocument();
  });

  it("restores after confirmation for admins", async () => {
    server.use(
      http.get("/api/versions", () => HttpResponse.json(VERSIONS)),
      http.post("/api/versions/2/restore", () => HttpResponse.json({ version: 4 })),
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
    );
    window.confirm = vi.fn(() => true);
    const { user } = renderPage(<HistoryPage />, "/ui/history");
    await screen.findByText("3");
    await user.click(screen.getByTitle("Восстановить версию 2"));
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toContain("Создана версия 4"));
  });
});
