import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import SubnetsPage from "./SubnetsPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("SubnetsPage", () => {
  it("uses the redesigned data surface", async () => {
    renderPage(<SubnetsPage />, "/ui/subnets", "d1");
    await screen.findByText("lan");

    expect(screen.getByTestId("page-subnets")).toHaveClass("subnets-page");
    expect(screen.getByRole("heading", { name: "Подсети", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сбросить ширины колонок" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: /Имя.*CIDR/ })).toBeInTheDocument();
    expect(screen.getByTitle("Изменить подсеть lan").parentElement).toHaveClass("subnet-actions");
  });

  it("lists subnets with their owning network", async () => {
    renderPage(<SubnetsPage />);
    expect(await screen.findByText("lan")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.0/24")).toBeInTheDocument();
    expect(screen.getByText("office")).toBeInTheDocument();
  });

  it("blocks editing without a draft", async () => {
    const { user } = renderPage(<SubnetsPage />);
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Изменить подсеть lan"));
    // notify-баннер, а не баннер драфта (там тоже есть «Только чтение»):
    // проверяем ровно то, что уведомление показано.
    expect(await screen.findByTestId("banner")).toHaveTextContent(/Только чтение/);
  });

  it("rejects a duplicate name in the edit dialog", async () => {
    // Дубликат имеет смысл только относительно другой подсети: своя текущая
    // имя остаётся разрешённой (uniqueNameHint пропускает selfIndex).
    server.use(http.get("/api/drafts/d1/subnets", () => HttpResponse.json({
      subnets: [...fx.subnetsFixture.subnets ?? [], { name: "dmz", cidr: "192.168.0.0/24" }],
    })));
    const { user } = renderPage(<SubnetsPage />, "/ui/subnets", "d1");
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Изменить подсеть lan"));
    const nameInput = await screen.findByLabelText("Имя");
    await user.clear(nameInput);
    await user.type(nameInput, "dmz");
    expect(screen.getByText("Имя уже используется")).toBeInTheDocument();
  });

  it("rejects an overlapping CIDR", async () => {
    const { user } = renderPage(<SubnetsPage />, "/ui/subnets", "d1");
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Добавить подсеть"));
    await user.type(await screen.findByLabelText("Имя"), "guest");
    await user.type(screen.getByLabelText("CIDR"), "10.0.0.128/25");
    expect(screen.getByText(/Пересекается с lan/)).toBeInTheDocument();
  });

  it("saves the whole list through PUT", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/subnets", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.subnetsFixture);
    }));
    const { user } = renderPage(<SubnetsPage />, "/ui/subnets", "d1");
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Добавить подсеть"));
    await user.type(await screen.findByLabelText("Имя"), "guest");
    await user.type(screen.getByLabelText("CIDR"), "192.168.5.0/24");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Подсети сохранены")).toBeInTheDocument();
    expect(body).toMatchObject({
      subnets: expect.arrayContaining([{ name: "guest", cidr: "192.168.5.0/24" }]),
    });
  });

  it("asks before deleting", async () => {
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    const { user } = renderPage(<SubnetsPage />, "/ui/subnets", "d1");
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Удалить подсеть lan"));
    expect(confirm).toHaveBeenCalled();
  });
});
