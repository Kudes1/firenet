import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import SearchPage from "./SearchPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("SearchPage", () => {
  it("lists all entries with a type badge", async () => {
    server.use(http.get("/api/versions/current/search-index", () => HttpResponse.json(fx.searchIndexFixture)));
    renderPage(<SearchPage />, "/ui/search");
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.0/24")).toBeInTheDocument();
  });

  it("filters by query and reports an empty result", async () => {
    server.use(http.get("/api/versions/current/search-index", () => HttpResponse.json(fx.searchIndexFixture)));
    const { user } = renderPage(<SearchPage />, "/ui/search");
    await screen.findByText("r1");
    await user.type(screen.getByRole("searchbox"), "нетакогообъекта");
    expect(await screen.findByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("links a row to the owning page", async () => {
    server.use(http.get("/api/versions/current/search-index", () => HttpResponse.json(fx.searchIndexFixture)));
    renderPage(<SearchPage />, "/ui/search");
    const row = await screen.findByText("r1");
    expect(row.closest("a")).toHaveAttribute("href", "/ui/devices");
  });
});
