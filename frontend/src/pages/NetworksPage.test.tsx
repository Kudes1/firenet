import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import NetworksPage from "./NetworksPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("NetworksPage", () => {
  it("uses the redesigned data surface", async () => {
    renderPage(<NetworksPage />, "/ui/networks", "d1");
    await screen.findByText("office");

    expect(screen.getByTestId("page-networks")).toHaveClass("networks-page");
    expect(screen.getByRole("heading", { name: "Сети", level: 1 })).toBeInTheDocument();
  });

  it("lists networks with their subnets", async () => {
    renderPage(<NetworksPage />, "/ui/networks", "d1");
    expect(await screen.findByText("office")).toBeInTheDocument();
    expect(screen.getByText("lan")).toBeInTheDocument();
  });

  it("saves a rename through the update-network operation", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    const { user } = renderPage(<NetworksPage />, "/ui/networks", "d1");
    await screen.findByText("office");
    await user.click(screen.getByTitle("Изменить сеть office"));
    const nameInput = await screen.findByLabelText("Имя");
    await user.clear(nameInput);
    await user.type(nameInput, "office2");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Сети сохранены")).toBeInTheDocument();
    expect(body).toMatchObject({
      kind: "update-network",
      networkName: "office",
      network: expect.objectContaining({ name: "office2" }),
    });
  });

  it("offers only free subnets in the add combo", async () => {
    server.use(http.get("/api/drafts/d1/subnets", () => HttpResponse.json({
      subnets: [{ name: "lan", cidr: "10.0.0.0/24" }, { name: "guest", cidr: "192.168.5.0/24" }],
    })));
    const { user } = renderPage(<NetworksPage />, "/ui/networks", "d1");
    await screen.findByText("office");
    await user.click(screen.getByTitle("Изменить сеть office"));
    await screen.findByLabelText("Имя");
    // lan уже в этой сети, guest свободна
    expect(screen.queryByText("lan (10.0.0.0/24)")).toBeNull();
    await user.click(screen.getByPlaceholderText("все подсети — начните вводить для поиска"));
    expect(screen.getByText("guest (192.168.5.0/24)")).toBeInTheDocument();
  });
});
