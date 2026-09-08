import { test, expect } from "@playwright/test";
import { op, getTopology, putSubnets, freshDraft } from "../helpers/api.js";
import { loginViaUI, openWithDraft, waitTopology } from "../helpers/ui.js";

// Две независимые группы (объединения): каждая — сеть с подсетями, switch и
// два роутера в LAN за switch'ем. Роутеры одной группы связаны с роутерами
// другой фильтрованной связью, каждый экспортирует через неё свою сеть —
// это даёт мультиудалению и живые межгрупповые связи, которые должны уйти
// каскадно, и соседнее объединение, которое не должно быть задето.
async function arrangeTwoUnions(request, id) {
  await putSubnets(request, id, [
    { name: "ua-sub1", cidr: "10.70.1.0/24" },
    { name: "ua-sub2", cidr: "10.70.2.0/24" },
    { name: "ub-sub1", cidr: "10.71.1.0/24" },
  ]);

  await op(request, id, { kind: "create-device", device: { name: "sw-a", kind: "switch" } });
  await op(request, id, { kind: "create-device", device: { name: "r-a1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "r-a2", kind: "router" } });
  await op(request, id, {
    kind: "create-network",
    network: { name: "net-a", subnets: ["ua-sub1", "ua-sub2"], attach: [{ device: "sw-a" }] },
  });
  await op(request, id, { kind: "create-link", link: { a: { device: "sw-a" }, b: { device: "r-a1" } } });
  await op(request, id, { kind: "create-link", link: { a: { device: "sw-a" }, b: { device: "r-a2" } } });
  await op(request, id, {
    kind: "create-union",
    union: { name: "union-a", devices: ["sw-a", "r-a1", "r-a2"], networks: ["net-a"] },
  });

  await op(request, id, { kind: "create-device", device: { name: "sw-b", kind: "switch" } });
  await op(request, id, { kind: "create-device", device: { name: "r-b1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "r-b2", kind: "router" } });
  await op(request, id, {
    kind: "create-network",
    network: { name: "net-b", subnets: ["ub-sub1"], attach: [{ device: "sw-b" }] },
  });
  await op(request, id, { kind: "create-link", link: { a: { device: "sw-b" }, b: { device: "r-b1" } } });
  await op(request, id, { kind: "create-link", link: { a: { device: "sw-b" }, b: { device: "r-b2" } } });
  await op(request, id, {
    kind: "create-union",
    union: { name: "union-b", devices: ["sw-b", "r-b1", "r-b2"], networks: ["net-b"] },
  });

  // Межгрупповые фильтрованные связи: каждый роутер отдаёт свою сеть.
  await op(request, id, {
    kind: "create-link",
    link: { a: { device: "r-a1" }, b: { device: "r-b1" }, filter: { aExports: ["net-a"], bExports: ["net-b"] } },
  });
  await op(request, id, {
    kind: "create-link",
    link: { a: { device: "r-a2" }, b: { device: "r-b2" }, filter: { aExports: ["net-a"], bExports: ["net-b"] } },
  });

  const positions = {
    "sw-a": { x: 200, y: 150 }, "r-a1": { x: 120, y: 320 }, "r-a2": { x: 280, y: 320 },
    "sw-b": { x: 900, y: 150 }, "r-b1": { x: 820, y: 320 }, "r-b2": { x: 980, y: 320 },
  };
  for (const [deviceName, position] of Object.entries(positions)) {
    await op(request, id, { kind: "set-device-position", deviceName, position });
  }
  await op(request, id, { kind: "set-network-position", networkName: "net-a", position: { x: 200, y: 480 } });
  await op(request, id, { kind: "set-network-position", networkName: "net-b", position: { x: 900, y: 480 } });
}

// Выделение узлов union-a: клик по первому, Ctrl+клик по остальным
// (multiSelectionKeyCode React Flow на Linux — Control; Shift включал бы
// рамку выделения).
async function selectUnionAAndDelete(page) {
  for (const [i, name] of ["sw-a", "r-a1", "r-a2", "net-a"].entries()) {
    const node = page.locator(`[data-testid="topo-canvas"] [data-testid="rf__node-${i === 3 ? "network" : "device"}:${name}"]`);
    await expect(node).toBeVisible();
    if (i === 0) await node.click({ position: { x: 30, y: 20 } });
    else await node.click({ position: { x: 30, y: 20 }, modifiers: ["Control"] });
  }
  await page.locator('[data-testid="topo-delete"]').click();
}

test("массовое удаление объединения снимает все его устройства и сеть, не задевая соседнее", async ({ page, request }) => {
  const id = await freshDraft(request, "delete-union");
  await arrangeTwoUnions(request, id);
  // Камера по умолчанию: мировые координаты == экранным, иначе fitView
  // подгонит масштаб и клики по узлам попадут не туда.
  await op(request, id, { kind: "set-camera", camera: { x: 0, y: 0, z: 1 } });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");

  await selectUnionAAndDelete(page);

  await waitTopology(request, id, (doc) => doc.topology.devices.every((d) => !["sw-a", "r-a1", "r-a2"].includes(d.name))
    && doc.topology.networks.every((n) => n.name !== "net-a"));

  const doc = await getTopology(request, id);
  const touches = (l, name) => l.a.device === name || l.b.device === name;

  // union-a ушёл целиком, вместе со всеми связями, которые его касались —
  // включая межгрупповую фильтрованную связь до union-b (снята сервером
  // каскадно при delete-device, клиент её явно не шлёт).
  expect(doc.topology.links.some((l) => touches(l, "sw-a") || touches(l, "r-a1") || touches(l, "r-a2"))).toBe(false);

  // union-b не задет: устройства, сеть, LAN-связи и членство в объединении на месте.
  expect(doc.topology.devices.map((d) => d.name)).toEqual(expect.arrayContaining(["sw-b", "r-b1", "r-b2"]));
  expect(doc.topology.networks.map((n) => n.name)).toContain("net-b");
  expect(doc.topology.links.filter((l) => touches(l, "sw-b"))).toHaveLength(2);
  const unionB = doc.topology.unions.find((u) => u.name === "union-b");
  expect(unionB.devices).toEqual(["sw-b", "r-b1", "r-b2"]);
  expect(unionB.networks).toEqual(["net-b"]);

  // Сама запись union-a остаётся (canvas чистит только устройства/сети, не
  // саму сущность объединения — UnionDoc это чисто визуальная группировка).
  const unionA = doc.topology.unions.find((u) => u.name === "union-a");
  expect(unionA).toBeTruthy();
  expect(unionA.devices || []).toEqual([]);
  expect(unionA.networks || []).toEqual([]);

  // Никакого конфликта черновика/ошибки синхронизации за время пакетного удаления.
  await expect(page.locator('[data-testid="banner"]')).toBeHidden();
});
