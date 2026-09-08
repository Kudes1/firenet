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
  it("shows the endpoint pair and the mode", async () => {
    renderPage(<LinksPage />, "/ui/links", "d1");
    expect(await screen.findByText("r1 ↔ sw1")).toBeInTheDocument();
    expect(screen.getByText("обычная")).toBeInTheDocument();
  });

  it("makes a link filtered", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/topology", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.topologyFixture);
    }));
    const { user } = renderPage(<LinksPage />, "/ui/links", "d1");
    await screen.findByText("r1 ↔ sw1");
    await user.click(screen.getByTitle("Сделать фильтрованной связь r1 ↔ sw1"));
    expect(await screen.findByText("Связи сохранены")).toBeInTheDocument();
    expect(body).toMatchObject({
      links: [{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: [], bExports: [] } }],
    });
  });

  it("loads export candidates for both sides by device pair", async () => {
    const urls: string[] = [];
    // PUT должен вернуть уже фильтрованную связь: onSuccess кладёт ответ в
    // кэш, и только после этого в строке появляется «Изменить фильтр».
    const filtered = {
      ...fx.topologyFixture,
      links: [{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: [], bExports: [] } }],
    };
    server.use(
      http.put("/api/drafts/d1/topology", () => HttpResponse.json(filtered)),
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
