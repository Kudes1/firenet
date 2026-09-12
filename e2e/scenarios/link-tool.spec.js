import { expect, test } from "@playwright/test";
import { login, createDraft, op } from "../helpers/api.js";
import {
  loginViaUI, openWithDraft, createDeviceNode, createNetworkNode,
  linkDevices, attachNetwork, waitTopology,
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

  // Connect-инструмент: клик по первому устройству, клик по второму.
  await linkDevices(page, r1, r2);

  await waitTopology(request, id, (doc) => {
    const t = doc.topology;
    return t.links.some((l) => l.a.device === r1 && l.b.device === r2);
  });
});

test("connect-инструмент: привязка сети к устройству", async ({ page, request }) => {
  const id = await freshDraft(page, request, "attach-tool");

  const r1 = await createDeviceNode(page, { x: 400, y: 300 });
  const net = await createNetworkNode(page, { x: 700, y: 500 });

  await attachNetwork(page, net, r1);

  await waitTopology(request, id, (doc) =>
    (doc.topology.networks || []).some((n) => n.name === net && (n.attach || []).some((a) => a.device === r1)));
});

test("connect-инструмент: повторная связь не дублируется", async ({ page, request }) => {
  const id = await freshDraft(page, request, "link-twice");

  const r1 = await createDeviceNode(page, { x: 400, y: 300 });
  const r2 = await createDeviceNode(page, { x: 700, y: 300 });

  await linkDevices(page, r1, r2);
  await waitTopology(request, id, (doc) => (doc.topology.links || []).length === 1);

  // Второй раз та же пара: баннер «уже соединены», документ не меняется.
  await linkDevices(page, r1, r2);
  await expect(page.locator('[data-testid="banner"]')).toContainText("уже соединены");
  await waitTopology(request, id, (doc) => (doc.topology.links || []).length === 1);
});
