import { test, expect } from "@playwright/test";
import { login, createDraft, op, getTopology } from "../helpers/api.js";
import {
  loginViaUI, openWithDraft, activateTool, createDeviceNode, createNetworkNode, waitTopology,
} from "../helpers/ui.js";

async function freshDraft(page, request, name) {
  await login(request);
  const id = await createDraft(request, name);
  // Камера по умолчанию: мировые координаты == экранным, иначе fitView
  // подгонит масштаб и клики по канве попадут не туда.
  await op(request, id, { kind: "set-camera", camera: { x: 0, y: 0, z: 1 } });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");
  return id;
}

test("создание роутера, свитча и сети инструментами канваса", async ({ page, request }) => {
  const id = await freshDraft(page, request, "create-objects");

  const r1 = await createDeviceNode(page, { x: 400, y: 300 });
  const r2 = await createDeviceNode(page, { x: 700, y: 300 });
  const net1 = await createNetworkNode(page, { x: 550, y: 550 });

  await waitTopology(request, id, (doc) => {
    const t = doc.topology;
    return t.devices.length === 2 && t.networks.some((n) => n.name === net1);
  });

  // Инструмент device создаёт роутеры (вид по умолчанию).
  const doc = (await getTopology(request, id)).topology;
  expect(doc.devices.map((d) => d.kind)).toEqual(["router", "router"]);
  expect(r1).not.toEqual(r2);
});
