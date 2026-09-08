import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import CompilePage from "./CompilePage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("CompilePage", () => {
  it("renders one section per device with both scripts", async () => {
    server.use(http.post("/api/versions/current/compile", () => HttpResponse.json(fx.compileFixture)));
    const { user } = renderPage(<CompilePage />, "/ui/compile");
    await user.click(screen.getByRole("button", { name: "Скомпилировать" }));
    expect(await screen.findByRole("heading", { name: "r1" })).toBeInTheDocument();
    expect(screen.getByText("create lan hash:net")).toBeInTheDocument();
    expect(screen.getByText("-A FORWARD -j ACCEPT")).toBeInTheDocument();
    expect(screen.getByText("ipset")).toBeInTheDocument();
    expect(screen.getByText("iptables")).toBeInTheDocument();
  });

  it("shows a compile error as a hint", async () => {
    server.use(http.post("/api/versions/current/compile", () =>
      HttpResponse.json({ error: "project is invalid" }, { status: 422 })));
    const { user } = renderPage(<CompilePage />, "/ui/compile");
    await user.click(screen.getByRole("button", { name: "Скомпилировать" }));
    expect(await screen.findByText("project is invalid")).toBeInTheDocument();
  });
});
