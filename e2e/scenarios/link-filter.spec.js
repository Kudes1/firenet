import { test, expect } from "@playwright/test";
import { login, createDraft } from "../helpers/api.js";
import {
  loginViaUI, openWithDraft, openTablePage, activateTool, createNode, canvasClick,
  contextMenuItem, waitTopology,
} from "../helpers/ui.js";

const draftName = (name) => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function createSubnet(page, name, cidr) {
  await page.getByRole("button", { name: "+ подсеть" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office-lan"]').fill(name);
  await dialog.locator('[placeholder="10.0.0.0/24"]').fill(cidr);
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
}

async function addNetworkMember(page, network, subnet) {
  const row = page.locator("tbody tr", { hasText: network });
  await row.locator(".icon-btn.edit").click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator(".member-add input").fill(subnet);
  await dialog.getByRole("button", { name: new RegExp(`^${subnet} \\(`) }).click();
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
}

async function freshDraft(page, request, name) {
  await login(request);
  const id = await createDraft(request, draftName(name));
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");
  await createSubnet(page, "lf-sub-a", "10.60.1.0/24");
  await createSubnet(page, "lf-sub-b", "10.60.2.0/24");
  return id;
}

async function arrangeLinkWithNetworks(page, id, request) {
  await openWithDraft(page, id, "/ui/topology");
  await activateTool(page, "device");
  await createNode(page, "lf-r1", { x: 400, y: 300 }, "router");
  await createNode(page, "lf-r2", { x: 700, y: 300 }, "router");
  await activateTool(page, "network");
  await createNode(page, "lf-net-a", { x: 400, y: 550 });
  await createNode(page, "lf-net-b", { x: 700, y: 550 });
  await activateTool(page, "connect");
  await canvasClick(page, 400, 300);
  await canvasClick(page, 700, 300);
  await canvasClick(page, 400, 550);
  await canvasClick(page, 400, 300);
  await canvasClick(page, 700, 550);
  await canvasClick(page, 700, 300);
  await waitTopology(request, id, (doc) => {
    const nets = doc.topology.networks;
    return doc.topology.links.length === 1
      && nets.every((n) => (n.attach || []).length === 1);
  });
  await openTablePage(page, id, "/ui/networks");
  await addNetworkMember(page, "lf-net-a", "lf-sub-a");
  await addNetworkMember(page, "lf-net-b", "lf-sub-b");
  await openWithDraft(page, id, "/ui/topology");
}

test("связь становится фильтрованной с экспортами и возвращается в обычную", async ({ page, request }) => {
  const id = await freshDraft(page, request, "link-filter");
  await arrangeLinkWithNetworks(page, id, request);

  await contextMenuItem(page, 550, 300, "Редактировать");
  const panel = page.locator("#link-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("strong")).toHaveText("Связь lf-r1 ↔ lf-r2");

  await panel.getByRole("button", { name: "Сделать фильтрованной" }).click();
  const selects = panel.locator(".member-add select");
  await selects.nth(0).selectOption({ label: "lf-net-a" });
  await selects.nth(1).selectOption({ label: "lf-net-b" });
  await panel.getByRole("button", { name: "Применить" }).click();
  await expect(panel).toBeHidden();

  await waitTopology(request, id, (doc) => {
    const f = doc.topology.links[0].filter;
    return !!f && f.aExports.includes("lf-net-a") && f.bExports.includes("lf-net-b");
  });

  await contextMenuItem(page, 550, 300, "Редактировать");
  await panel.getByRole("button", { name: "Вернуть обычную" }).click();
  await panel.getByRole("button", { name: "Применить" }).click();
  await expect(panel).toBeHidden();

  await waitTopology(request, id, (doc) => doc.topology.links[0].filter == null);
});
