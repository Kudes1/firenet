import { test } from "@playwright/test";
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

test("connect-инструмент: связь устройство–устройство и привязка сети", async ({ page, request }) => {
  const id = await freshDraft(page, request, "link-tool");

  await activateTool(page, "device");
  await createNode(page, "lt-r1", { x: 400, y: 300 }, "router");
  await createNode(page, "lt-r2", { x: 700, y: 300 }, "router");
  await activateTool(page, "network");
  await createNode(page, "lt-net", { x: 550, y: 550 });

  await activateTool(page, "connect");
  await canvasClick(page, 400, 300);
  await canvasClick(page, 700, 300);
  await canvasClick(page, 550, 550);
  await canvasClick(page, 400, 300);

  await waitTopology(request, id, (doc) => {
    const t = doc.topology;
    return t.links.some((l) => l.a.device === "lt-r1" && l.b.device === "lt-r2")
      && t.networks.some((n) => n.name === "lt-net"
        && (n.attach || []).some((a) => a.device === "lt-r1"));
  });
});
