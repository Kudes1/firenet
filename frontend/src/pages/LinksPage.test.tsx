import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import LinksPage from "./LinksPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("LinksPage", () => {
  it("shows the redesigned heading, status styling, and table controls", async () => {
    renderPage(<LinksPage />, "/ui/links", "d1");

    expect(await screen.findByRole("heading", { name: "Связи", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Логические соединения между устройствами и их фильтры.")).toBeInTheDocument();
    expect(await screen.findByText("обычная")).toHaveClass("link-mode", "link-mode-plain");
    expect(screen.getByRole("button", { name: "Сбросить ширины колонок" })).toBeInTheDocument();
  });

  it("shows the endpoint pair and the mode", async () => {
    renderPage(<LinksPage />, "/ui/links", "d1");
    expect(await screen.findByText("r1 ↔ sw1")).toBeInTheDocument();
    expect(screen.getByText("обычная")).toBeInTheDocument();
  });

  it("moves the filter sides with the swapped endpoint pair", async () => {
    // Связь хранится как sw1→r1: после канонизации строки в «r1 ↔ sw1»
    // экспорт, записанный на стороне sw1 (aExports), должен оказаться
    // в колонке «← Экспорт» (sw1), а не «Экспорт →» (r1).
    server.use(http.get("/api/drafts/d1/topology", () => HttpResponse.json({
      ...fx.topologyFixture,
      links: [{ a: { device: "sw1" }, b: { device: "r1" }, filter: { aExports: ["lan"], bExports: [] } }],
    })));
    renderPage(<LinksPage />, "/ui/links", "d1");

    expect(await screen.findByText("r1 ↔ sw1")).toBeInTheDocument();
    const cell = screen.getByText("lan").closest("td");
    expect(cell).not.toBeNull();
    // Порядок колонок: pair(0), mode(1), aExports(2), bExports(3).
    // Экспорт sw1 должен быть в «← Экспорт» (колонка 3), а не в «Экспорт →» (2).
    const row = cell!.closest("tr")!;
    const index = Array.from(row.querySelectorAll("td")).indexOf(cell!);
    expect(index).toBe(3);
  });

  it("makes a link filtered", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({
        topology: {
          ...fx.topologyFixture,
          links: [{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: [], bExports: [] } }],
        },
        layout: fx.layoutFixture,
      });
    }));
    const { user } = renderPage(<LinksPage />, "/ui/links", "d1");
    await screen.findByText("r1 ↔ sw1");
    await user.click(screen.getByTitle("Сделать фильтрованной связь r1 ↔ sw1"));
    expect(await screen.findByText("Связи сохранены")).toBeInTheDocument();
    expect(body).toEqual({
      kind: "set-link-filter",
      link: { a: { device: "r1" }, b: { device: "sw1" } },
      filter: { aExports: [], bExports: [] },
    });
  });

  it("loads export candidates for both sides by device pair", async () => {
    const urls: string[] = [];
    // Операция должна вернуть уже фильтрованную связь: onSuccess кладёт ответ в
    // кэш, и только после этого в строке появляется «Изменить фильтр».
    const filtered = {
      ...fx.topologyFixture,
      links: [{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: [], bExports: [] } }],
    };
    server.use(
      http.post("/api/drafts/d1/topology/operations", () => HttpResponse.json({ topology: filtered, layout: fx.layoutFixture })),
      http.get("/api/drafts/d1/link-exports", ({ request }) => {
        urls.push(new URL(request.url).search);
        return HttpResponse.json({ entities: [{ name: "lan", cidr: "10.0.0.0/24" }] });
      }),
    );
    const { user } = renderPage(<LinksPage />, "/ui/links", "d1");
    await screen.findByText("r1 ↔ sw1");
    await user.click(screen.getByTitle("Сделать фильтрованной связь r1 ↔ sw1"));
    await screen.findByText("Связи сохранены");
    await user.click(screen.getByTitle("Изменить фильтр связи r1 ↔ sw1"));
    // «Экспорт» встречается дважды — по заголовку на каждую сторону связи.
    expect((await screen.findAllByText("Экспорт")).length).toBe(2);
    expect(urls.some((u) => u.includes("side=a") && u.includes("a=r1") && u.includes("b=sw1"))).toBe(true);
    expect(urls.some((u) => u.includes("side=b"))).toBe(true);
  });
});
