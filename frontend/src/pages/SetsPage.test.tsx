import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import SetsPage from "./SetsPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("SetsPage", () => {
  it("lists sets with addresses", async () => {
    renderPage(<SetsPage />, "/ui/sets", "d1");
    expect(await screen.findByText("srv")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.5/32")).toBeInTheDocument();
  });

  it("rejects a set with neither subnets nor addresses", async () => {
    const { user } = renderPage(<SetsPage />, "/ui/sets", "d1");
    await screen.findByText("srv");
    await user.click(screen.getByTitle("Добавить набор"));
    await user.type(await screen.findByLabelText("Имя"), "empty");
    expect(screen.getByText("Нужна хотя бы одна подсеть или адрес")).toBeInTheDocument();
  });

  it("normalizes a bare IP to /32 and rejects a short mask", async () => {
    const { user } = renderPage(<SetsPage />, "/ui/sets", "d1");
    await screen.findByText("srv");
    await user.click(screen.getByTitle("Изменить набор srv"));
    await user.type(await screen.findByPlaceholderText("10.0.0.5"), "10.0.0.9");
    await user.click(screen.getByTitle("Добавить адрес"));
    expect(screen.getByText("10.0.0.9/32")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("10.0.0.5"), "10.0.0.0/24");
    await user.click(screen.getByTitle("Добавить адрес"));
    expect(screen.getByText("Адрес: голый IP или маска /32 (для IPv6 — /128)")).toBeInTheDocument();
  });

  it("saves the whole topology with the new sets", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/topology", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.topologyFixture);
    }));
    const { user } = renderPage(<SetsPage />, "/ui/sets", "d1");
    await screen.findByText("srv");
    await user.click(screen.getByTitle("Добавить набор"));
    await user.type(await screen.findByLabelText("Имя"), "web");
    // адрес делает набор валидным
    await user.type(screen.getByPlaceholderText("10.0.0.5"), "10.0.0.7");
    await user.click(screen.getByTitle("Добавить адрес"));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Наборы сохранены")).toBeInTheDocument();
    // arrayContaining внутри toMatchObject сверяет элементы строго, поэтому
    // проверяем новый набор через objectContaining (подмножество полей).
    expect(body).toMatchObject({
      sets: expect.arrayContaining([
        expect.objectContaining({ name: "web", addresses: ["10.0.0.7/32"] }),
      ]),
    });
  });
});
