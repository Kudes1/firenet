import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import DraftsPage from "./DraftsPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("DraftsPage", () => {
  it("lists own drafts", async () => {
    server.use(
      // useMe вызывается всегда; дефолтного хендлера /api/me нет (renderPage
      // его не ставит), поэтому задаём явно — иначе MSW вернёт 404 и isReadOnly
      // тумблер для admin просто не отрисуется.
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      http.get("/api/drafts", () => HttpResponse.json([fx.draftFixture])),
    );
    renderPage(<DraftsPage />, "/ui/drafts");
    expect(await screen.findByText("правки")).toBeInTheDocument();
    expect(screen.getByTestId("data-table")).toHaveAttribute("id", "drafts-table");
    expect(screen.getByRole("heading", { name: "Черновики", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("open")).toHaveClass("draft-status", "draft-status-open");
    expect(screen.getByRole("button", { name: "Сбросить ширины колонок" })).toBeInTheDocument();

    expect(screen.getByTitle("Открыть черновик правки")).not.toHaveClass("btn-link");
    expect(screen.getByTitle("Изменения черновика правки")).toHaveClass("secondary");
    expect(screen.getByTitle("Подтвердить черновик правки")).toHaveClass("primary");
  });

  it("uses the shared table surface and filters drafts", async () => {
    server.use(
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      http.get("/api/drafts", () => HttpResponse.json([
        fx.draftFixture,
        { ...fx.draftFixture, id: "d2", name: "релиз" },
      ])),
    );
    const { user } = renderPage(<DraftsPage />, "/ui/drafts");
    expect(await screen.findByTestId("data-table")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Открыть поиск" }));
    await user.type(screen.getByPlaceholderText("Название"), "релиз");

    expect(screen.getByText("релиз")).toBeInTheDocument();
    expect(screen.queryByText("правки")).not.toBeInTheDocument();
  });

  it("shows all drafts for admins when toggled", async () => {
    server.use(
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      // useDrafts(all && role==="admin") лениво: первый рендер идёт на /api/drafts
      // (me.data ещё undefined → all=false), после клика — на /api/drafts?all=1.
      // MSW 2 не матчит query-параметры, записанные в URL хендлера, —
      // разбираем searchParams вручную.
      http.get("/api/drafts", ({ request }) => {
        const all = new URL(request.url).searchParams.has("all");
        return HttpResponse.json(all
          ? [fx.draftFixture, { ...fx.draftFixture, id: "d2", name: "чужой" }]
          : [fx.draftFixture]);
      }),
    );
    const { user } = renderPage(<DraftsPage />, "/ui/drafts");
    const toggle = await screen.findByLabelText("Показывать все");
    await user.click(toggle);
    expect(await screen.findByText("чужой")).toBeInTheDocument();
  });

  it("creates a draft", async () => {
    let body: unknown;
    const drafts: unknown[] = [];
    server.use(
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      // Список растёт внутри хендлера: useCreateDraft.onSuccess инвалидирует
      // ["drafts"], и после мутации GET /api/drafts вызывается повторно.
      // Если вернуть константу [], созданный черновик исчезнет из таблицы.
      http.get("/api/drafts", () => HttpResponse.json(drafts)),
      http.post("/api/drafts", async ({ request }) => {
        body = await request.json();
        drafts.push(fx.draftFixture);
        return HttpResponse.json(fx.draftFixture, { status: 201 });
      }),
    );
    const { user } = renderPage(<DraftsPage />, "/ui/drafts");
    await user.type(await screen.findByLabelText("Название"), "мой черновик");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    expect(await screen.findByText("правки")).toBeInTheDocument();
    expect(body).toEqual({ name: "мой черновик" });
  });

  it("shows the diff with conflict rows marked", async () => {
    server.use(
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      http.get("/api/drafts", () => HttpResponse.json([fx.draftFixture])),
      http.get("/api/drafts/d1/diff", () => HttpResponse.json([
        { kind: "device", key: "r1", change: "modified", conflict: true },
      ])),
    );
    const { user } = renderPage(<DraftsPage />, "/ui/drafts");
    await screen.findByText("правки");
    await user.click(screen.getByTitle("Изменения черновика правки"));
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(screen.getByText("изменено (конфликт)")).toBeInTheDocument();
  });

  it("surfaces a 409 with conflicts as a banner, not a crash", async () => {
    server.use(
      http.get("/api/drafts", () => HttpResponse.json([fx.draftFixture])),
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      http.post("/api/drafts/d1/confirm", () => HttpResponse.json(
        { conflicts: [{ kind: "device", key: "r1" }] }, { status: 409 })),
      // onConfirm при конфликте делает setDiffFor(d1), что запускает этот запрос.
      http.get("/api/drafts/d1/diff", () => HttpResponse.json([])),
    );
    const { user } = renderPage(<DraftsPage />, "/ui/drafts");
    await screen.findByText("правки");
    await user.click(screen.getByTitle("Подтвердить черновик правки"));
    expect(await screen.findByTestId("banner")).toBeInTheDocument();
  });
});
