import { test, expect } from "@playwright/test";
import { login, createDraft } from "../helpers/api.js";
import {
  loginViaUI, openWithDraft, activateTool, createNode, canvasClick, waitTopology,
} from "../helpers/ui.js";

async function freshDraft(page, request, name) {
  await login(request);
  const id = await createDraft(request, name);
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");
  return id;
}

test("создание роутера, свитча и сети инструментами канваса", async ({ page, request }) => {
  const id = await freshDraft(page, request, "create-objects");

  await activateTool(page, "device");
  await createNode(page, "e2e-r1", { x: 400, y: 300 }, "router");
  await createNode(page, "e2e-sw1", { x: 700, y: 300 }, "switch");

  await activateTool(page, "network");
  await createNode(page, "e2e-net1", { x: 550, y: 550 });

  await waitTopology(request, id, (doc) => {
    const t = doc.topology;
    return t.devices.some((d) => d.name === "e2e-r1" && d.kind === "router")
      && t.devices.some((d) => d.name === "e2e-sw1" && d.kind === "switch")
      && t.networks.some((n) => n.name === "e2e-net1");
  });

  await activateTool(page, "select");
  await canvasClick(page, 400, 300);
  await expect(page.locator("#topo-delete")).toBeEnabled();
});
