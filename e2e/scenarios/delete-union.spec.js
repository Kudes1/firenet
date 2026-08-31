import { test, expect } from "@playwright/test";
import { op, getTopology, putSubnets, freshDraft } from "../helpers/api.js";
import { loginViaUI, openWithDraft, dragNode, waitTopology } from "../helpers/ui.js";

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

test("массовое удаление объединения снимает все его устройства и сеть, не задевая соседнее", async ({ page, request }) => {
  const id = await freshDraft(request, "delete-union");
  await arrangeTwoUnions(request, id);
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");

  // Рамка вокруг всех узлов union-a (sw-a/r-a1/r-a2/net-a); union-b лежит
  // далеко за правым краем рамки и её не задевает (dragNode на пустом месте
  // канваса в режиме select — это marquee, см. topology.js:startMarquee).
  await dragNode(page, { x: 20, y: 60 }, { x: 380, y: 560 });

  // confirm() блокирует выполнение страницы, поэтому click() нельзя await'ить
  // раньше диалога — иначе click() никогда не разрешится (см. delete.spec.js).
  const dialogP = page.waitForEvent("dialog", { timeout: 5_000 });
  const clickP = page.locator("#topo-delete").click();
  const dialog = await dialogP;
  // Не toBe: на общем тестовом сервере черновик наследует текущую версию
  // как базу, которая может уже нести устройства из других сценариев —
  // здесь важно только что union-a целиком вошёл в подтверждение, а не
  // что в нём БОЛЬШЕ никого нет.
  for (const name of ["устройство r-a1", "устройство r-a2", "устройство sw-a", "сеть net-a"]) {
    expect(dialog.message()).toContain(name);
  }
  await dialog.accept();
  await clickP;

  await waitTopology(request, id, (doc) => doc.topology.devices.every((d) => !["sw-a", "r-a1", "r-a2"].includes(d.name))
    && doc.topology.networks.every((n) => n.name !== "net-a"));

  const doc = await getTopology(request, id);
  const touches = (l, name) => l.a.device === name || l.b.device === name;

  // union-a ушёл целиком, вместе со всеми связями, которые его касались —
  // включая межгрупповую фильтрованную связь до union-b (снята сервером
  // каскадно при delete-device, клиент её явно не шлёт — topology.js:622-632).
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
  await expect(page.locator("#error-banner")).toBeHidden();
});

// arrangeUnionBehindSwitch builds one union where the network's only path
// to the rest of the graph is a switch that sorts alphabetically before its
// own router (matching a name-sorted multi-select delete's op order), and a
// second, independent union whose router reaches the first union's network
// only through a filtered link outside the deleted batch. Deleting the
// switch before the router it serves breaks that filtered link's export
// reachability if the deletion isn't applied as one atomic step — this is
// the shape multi-select delete must handle, not the two-router-per-side
// layout above (there the filtered link's own endpoint is what gets
// deleted, which trivially drops the link along with it).
async function arrangeUnionBehindSwitch(request, id) {
  await putSubnets(request, id, [{ name: "shop-sub", cidr: "10.80.0.0/24" }, { name: "dc-sub", cidr: "10.81.0.0/24" }]);

  await op(request, id, { kind: "create-device", device: { name: "shop-core", kind: "switch" } });
  await op(request, id, { kind: "create-device", device: { name: "shop-gw", kind: "router" } });
  await op(request, id, {
    kind: "create-network",
    network: { name: "shop-net", subnets: ["shop-sub"], attach: [{ device: "shop-core" }] },
  });
  await op(request, id, { kind: "create-link", link: { a: { device: "shop-core" }, b: { device: "shop-gw" } } });
  await op(request, id, {
    kind: "create-union",
    union: { name: "union-shop", devices: ["shop-core", "shop-gw"], networks: ["shop-net"] },
  });

  await op(request, id, { kind: "create-device", device: { name: "dc-core", kind: "switch" } });
  await op(request, id, { kind: "create-device", device: { name: "dc-gw", kind: "router" } });
  await op(request, id, {
    kind: "create-network",
    network: { name: "dc-net", subnets: ["dc-sub"], attach: [{ device: "dc-core" }] },
  });
  await op(request, id, { kind: "create-link", link: { a: { device: "dc-core" }, b: { device: "dc-gw" } } });
  await op(request, id, {
    kind: "create-union",
    union: { name: "union-dc", devices: ["dc-core", "dc-gw"], networks: ["dc-net"] },
  });

  // shop-gw exports shop-net (reachable only via shop-core) to dc-gw.
  await op(request, id, {
    kind: "create-link",
    link: { a: { device: "shop-gw" }, b: { device: "dc-gw" }, filter: { aExports: ["shop-net"], bExports: ["dc-net"] } },
  });

  const positions = {
    "shop-core": { x: 200, y: 150 }, "shop-gw": { x: 200, y: 320 },
    "dc-core": { x: 900, y: 150 }, "dc-gw": { x: 900, y: 320 },
  };
  for (const [deviceName, position] of Object.entries(positions)) {
    await op(request, id, { kind: "set-device-position", deviceName, position });
  }
  await op(request, id, { kind: "set-network-position", networkName: "shop-net", position: { x: 200, y: 480 } });
  await op(request, id, { kind: "set-network-position", networkName: "dc-net", position: { x: 900, y: 480 } });
}

test("удаление объединения не спотыкается о промежуточное состояние: свитч удаляется раньше роутера, чья внешняя связь ещё отдаёт сеть через него", async ({ page, request }) => {
  const id = await freshDraft(request, "delete-union-behind-switch");
  await arrangeUnionBehindSwitch(request, id);
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");

  await dragNode(page, { x: 20, y: 60 }, { x: 380, y: 560 }); // рамка вокруг union-shop

  const dialogP = page.waitForEvent("dialog", { timeout: 5_000 });
  const clickP = page.locator("#topo-delete").click();
  const dialog = await dialogP;
  // Алфавитный порядок: "shop-core" раньше "shop-gw" — свитч уходит первым.
  expect(dialog.message()).toContain("устройство shop-core");
  expect(dialog.message()).toContain("устройство shop-gw");
  expect(dialog.message()).toContain("сеть shop-net");
  await dialog.accept();
  await clickP;

  await waitTopology(request, id, (doc) => doc.topology.devices.every((d) => !["shop-core", "shop-gw"].includes(d.name))
    && doc.topology.networks.every((n) => n.name !== "shop-net"));

  const doc = await getTopology(request, id);
  const touches = (l, name) => l.a.device === name || l.b.device === name;
  expect(doc.topology.links.some((l) => touches(l, "shop-core") || touches(l, "shop-gw"))).toBe(false);

  // union-dc не задет: связь до союза-shop ушла вместе с ним, но собственные
  // устройство/сеть/LAN-связь остались.
  expect(doc.topology.devices.map((d) => d.name)).toEqual(expect.arrayContaining(["dc-core", "dc-gw"]));
  expect(doc.topology.networks.map((n) => n.name)).toContain("dc-net");
  expect(doc.topology.links.filter((l) => touches(l, "dc-core") || touches(l, "dc-gw"))).toHaveLength(1);

  // Ключевая регрессия: никакой ошибки — ни "конфликт черновика", ни 422 о
  // недостижимом экспорте.
  await expect(page.locator("#error-banner")).toBeHidden();
});
