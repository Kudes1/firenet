import { test, expect } from "@playwright/test";
import { op, getTopology, getSubnets, putSubnets, putTopology, freshDraft } from "../helpers/api.js";
import {
  loginViaUI, openWithDraft, openTablePage, waitTopology,
} from "../helpers/ui.js";

async function arrangeDeviceWithLink(request, id) {
  await op(request, id, { kind: "create-device", device: { name: "d-r1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "d-r2", kind: "router" } });
  await op(request, id, { kind: "set-device-position", deviceName: "d-r1", position: { x: 400, y: 300 } });
  await op(request, id, { kind: "set-device-position", deviceName: "d-r2", position: { x: 700, y: 300 } });
  await op(request, id, {
    kind: "create-link", link: { a: { device: "d-r1" }, b: { device: "d-r2" } },
  });
}

// selectSearchResult выделяет поисковый хит кликом в центр канваса и
// удаляет его. Клик во время полёта камеры (tween 180ms после поиска) может
// зацепить провод привязки или связь: #topo-delete при этом активируется, а
// связи и привязки удаляются молча, без confirm (topology.js: setupDeleteButton).
// Поэтому цель проверяем по тексту подтверждающего диалога: не тот объект —
// диалог отклоняем и выбираем заново; после остановки полёта центр канваса
// попадает в сам узел.
async function selectSearchResult(page, query, expectDeleted) {
  await page.locator("#topo-search-toggle").click();
  await page.locator("#topo-search").fill(query);
  const box = await page.locator("#topo-canvas").boundingBox();
  if (!box) throw new Error("канвас не виден");
  const canvas = page.locator("#topo-canvas");
  const remove = page.locator("#topo-delete");
  const select = () => expect.poll(async () => {
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    return remove.isEnabled();
  }, { timeout: 2_000 }).toBe(true);
  for (;;) {
    await select();
    const dialogP = page.waitForEvent("dialog", { timeout: 5_000 });
    dialogP.catch(() => {});
    const silentP = page
      .waitForFunction(() => document.getElementById("topo-delete").disabled, null, { timeout: 5_000 })
      .then(() => null);
    silentP.catch(() => {});
    const clickP = remove.click();
    const dialog = await Promise.race([dialogP, silentP]);
    const matched = !!dialog && dialog.message().includes(expectDeleted);
    if (dialog) await (matched ? dialog.accept() : dialog.dismiss());
    await clickP;
    if (matched) return;
  }
}

test("удаление устройства со связью убирает и связь", async ({ page, request }) => {
  const id = await freshDraft(request, "delete-device");
  await arrangeDeviceWithLink(request, id);
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");

  await selectSearchResult(page, "d-r1", "устройство d-r1");

  await waitTopology(request, id, (doc) => doc.topology.devices.every((d) => d.name !== "d-r1"));
  const doc = await getTopology(request, id);
  expect(doc.topology.links || []).toEqual([]);
});

test("удаление сети чистит экспорты фильтров", async ({ page, request }) => {
  const id = await freshDraft(request, "delete-net");
  await putSubnets(request, id, [{ name: "dn-sub", cidr: "10.61.0.0/24" }]);
  await arrangeDeviceWithLink(request, id);
  await op(request, id, {
    kind: "create-network", network: { name: "dn-net", subnets: ["dn-sub"] },
  });
  await op(request, id, { kind: "attach-network", networkName: "dn-net", attach: { device: "d-r1" } });
  await op(request, id, { kind: "set-network-position", networkName: "dn-net", position: { x: 550, y: 550 } });
  await op(request, id, {
    kind: "set-link-filter",
    link: { a: { device: "d-r1" }, b: { device: "d-r2" } },
    filter: { aExports: ["dn-net"], bExports: [] },
  });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");

  await selectSearchResult(page, "dn-net", "сеть dn-net");

  await waitTopology(request, id, (doc) => (doc.topology.networks || []).length === 0);
  const doc = await getTopology(request, id);
  expect(doc.topology.links[0].filter.aExports).toEqual([]);
});

test("удаление одиночной подсети", async ({ page, request }) => {
  const id = await freshDraft(request, "delete-sub");
  await putSubnets(request, id, [{ name: "ds-lan", cidr: "10.4.0.0/24" }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("tbody tr", { hasText: "ds-lan" }).locator(".icon-btn.delete").click();

  await expect.poll(async () => (await getSubnets(request, id)).subnets || [], { timeout: 5_000 }).toHaveLength(0);
});

test("удаление подсети-члена сети блокируется guard'ом", async ({ page, request }) => {
  const id = await freshDraft(request, "delete-nested-sub");
  await putSubnets(request, id, [{ name: "dns-sub", cidr: "10.9.0.0/24" }]);
  await op(request, id, { kind: "create-network", network: { name: "dns-net", subnets: ["dns-sub"] } });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("tbody tr", { hasText: "dns-sub" }).locator(".icon-btn.delete").click();

  await expect(page.locator("#error-banner")).toBeVisible({ timeout: 5_000 });
  const doc = await getSubnets(request, id);
  expect(doc.subnets.map((s) => s.name)).toContain("dns-sub");
});

test("удаление набора", async ({ page, request }) => {
  const id = await freshDraft(request, "delete-set");
  await putSubnets(request, id, [{ name: "dset-sub", cidr: "10.6.0.0/24" }]);
  await putTopology(request, id, {
    devices: [],
    links: [],
    networks: [{ name: "dset-net", subnets: ["dset-sub"] }],
    sets: [{ name: "dset-set", subnets: ["dset-sub"] }],
    unions: [],
  });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/sets");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("tbody tr", { hasText: "dset-set" }).locator(".icon-btn.delete").click();

  await expect.poll(async () => (await getTopology(request, id)).topology.sets || [], { timeout: 5_000 }).toHaveLength(0);
});
