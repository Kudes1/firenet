import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import RulesPage from "./RulesPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("RulesPage", () => {
  it("shows the primary chain and its rules", async () => {
    renderPage(<RulesPage />, "/ui/rules", "d1");
    expect(await screen.findByText("FORWARD")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("rejects a rule without src or dst", async () => {
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("web");
    await user.click(screen.getByTitle("Добавить правило"));
    await user.type(await screen.findByLabelText("Имя"), "bad");
    expect(screen.getByText("Нужен хотя бы один источник")).toBeInTheDocument();
    expect(screen.getByText("Нужен хотя бы один получатель")).toBeInTheDocument();
  });

  it("rejects ports on icmp and a bad port spec", async () => {
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("web");
    await user.click(screen.getByTitle("Добавить правило"));
    await user.type(await screen.findByLabelText("Имя"), "p");
    // src и dst обязательны: проверка портов в ruleHint идёт после концов
    await user.click(screen.getAllByPlaceholderText("any, подсеть или набор")[0]);
    await user.click(screen.getByText("any", { selector: ".member-suggestion" }));
    await user.click(screen.getAllByPlaceholderText("any, подсеть или набор")[1]);
    await user.click(screen.getByText("any", { selector: ".member-suggestion" }));
    await user.selectOptions(screen.getByLabelText("Протокол"), "icmp");
    await user.type(screen.getByLabelText("Порты получателя"), "80");
    expect(screen.getByText("Порты допустимы только для tcp и udp")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Протокол"), "tcp");
    await user.clear(screen.getByLabelText("Порты получателя"));
    await user.type(screen.getByLabelText("Порты получателя"), "2048-1024");
    expect(screen.getByText("Порты: 1..65535 или диапазон from-to")).toBeInTheDocument();
  });

  it("saves the whole policy", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/rules", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.policyFixture);
    }));
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("web");
    await user.click(screen.getByTitle("Добавить правило"));
    await user.type(await screen.findByLabelText("Имя"), "ssh");
    // src и dst через комбобоксы: any доступен первым кандидатом
    await user.click(screen.getAllByPlaceholderText("any, подсеть или набор")[0]);
    await user.click(screen.getByText("any", { selector: ".member-suggestion" }));
    await user.click(screen.getAllByPlaceholderText("any, подсеть или набор")[1]);
    await user.click(screen.getByText("any", { selector: ".member-suggestion" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => {
      const policy = body as { chains: Array<{ rules: Array<{ name: string }> }> };
      expect(policy.chains[0].rules.some((r) => r.name === "ssh")).toBe(true);
    });
  });

  it("moves a rule and persists the chain", async () => {
    server.use(
      http.get("/api/drafts/d1/rules", () => HttpResponse.json({
        chains: [{
          name: "FORWARD", defaultAction: "deny", chainPosition: "top",
          rules: [
            { name: "a", src: ["any"], dst: ["any"], action: "allow" },
            { name: "b", src: ["any"], dst: ["any"], action: "allow" },
          ],
        }],
      })),
      http.put("/api/drafts/d1/rules", async ({ request }) =>
        HttpResponse.json(await request.json())),
    );
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("a");
    await user.click(screen.getByTitle("Переместить правило b выше"));
    await waitFor(() => {
      const names = screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
      expect(names[0]).toContain("b");
    });
  });

  it("shows lint findings", async () => {
    server.use(http.get("/api/drafts/d1/lint", () => HttpResponse.json({ findings: fx.lintFixture })));
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("web");
    await user.click(screen.getByRole("button", { name: "Проверить" }));
    expect(await screen.findByText("правило недостижимо")).toBeInTheDocument();
  });

  it("refuses to delete a chain targeted by jump", async () => {
    server.use(http.get("/api/drafts/d1/rules", () => HttpResponse.json({
      chains: [
        { name: "FORWARD", defaultAction: "deny", chainPosition: "top", rules: [
          { name: "j", src: ["any"], dst: ["any"], action: "jump", jumpTo: "sub" },
        ] },
        { name: "sub", defaultAction: "deny", rules: [] },
      ],
    })));
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("j");
    await user.click(screen.getByTitle("Удалить цепочку sub"));
    expect(await screen.findByText(/используется действием jump/)).toBeInTheDocument();
  });
});
