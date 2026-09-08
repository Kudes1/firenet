import { test } from "@playwright/test";
import { login, createDraft, op } from "../helpers/api.js";
import {
  loginViaUI, openWithDraft, createDeviceNode, linkDevices, waitTopology,
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

test("connect-инструмент: связь устройство–устройство", async ({ page, request }) => {
  const id = await freshDraft(page, request, "link-tool");

  const r1 = await createDeviceNode(page, { x: 400, y: 300 });
  const r2 = await createDeviceNode(page, { x: 700, y: 300 });

  // Связь через click-connect React Flow: клик по source-хэндлу первого
  // узла, затем по target-хэндлу второго.
  await linkDevices(page, r1, r2);

  await waitTopology(request, id, (doc) => {
    const t = doc.topology;
    return t.links.some((l) => l.a.device === r1 && l.b.device === r2);
  });
});
