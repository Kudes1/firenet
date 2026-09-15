import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import UnionsPage from "./UnionsPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("UnionsPage", () => {
  it("lists unions and their members", async () => {
    renderPage(<UnionsPage />, "/ui/unions", "d1");
    expect(await screen.findByText("u1")).toBeInTheDocument();
    expect(screen.getByText("r1")).toBeInTheDocument();
  });

  it("shows the redesigned table surface", async () => {
    renderPage(<UnionsPage />, "/ui/unions", "d1");
    await screen.findByText("u1");

    expect(screen.getByTestId("page-unions")).toHaveClass("unions-page");
    expect(screen.getByRole("heading", { name: "Объединения", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: /Имя.*Устройства/ })).toBeInTheDocument();
  });

  it("says membership is set on the canvas", async () => {
    const { user } = renderPage(<UnionsPage />, "/ui/unions", "d1");
    await screen.findByText("u1");
    await user.click(screen.getByTitle("Изменить объединение u1"));
    expect(await screen.findByText(/назначается на холсте топологии/)).toBeInTheDocument();
  });

  it("creates a union with empty members", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/topology", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.topologyFixture);
    }));
    const { user } = renderPage(<UnionsPage />, "/ui/unions", "d1");
    await screen.findByText("u1");
    await user.click(screen.getByTitle("Добавить объединение"));
    await user.type(await screen.findByLabelText("Имя"), "u2");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Объединения сохранены")).toBeInTheDocument();
    expect(body).toMatchObject({ unions: expect.arrayContaining([{ name: "u2", devices: [], networks: [] }]) });
  });
});
