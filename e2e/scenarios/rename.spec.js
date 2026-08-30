import { test, expect } from "@playwright/test";
import {
  login, createDraft, op, getTopology, getRules, getSubnets, putRules, putSubnets, putTopology,
} from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

const draftName = (name) => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function freshDraft(request, name) {
  await login(request);
  return createDraft(request, draftName(name));
}

async function arrangeConnected(request, id) {
  await putSubnets(request, id, [{ name: "rn-sub", cidr: "10.99.0.0/24" }]);
  await op(request, id, { kind: "create-device", device: { name: "rn-r1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "rn-r2", kind: "router" } });
  await op(request, id, {
    kind: "create-network",
    network: { name: "rn-net", subnets: ["rn-sub"] },
  });
  await op(request, id, {
    kind: "attach-network", networkName: "rn-net", attach: { device: "rn-r1" },
  });
  await op(request, id, {
    kind: "create-link",
    link: {
      a: { device: "rn-r1" }, b: { device: "rn-r2" },
      filter: { aExports: ["rn-net"], bExports: [] },
    },
  });
  await putRules(request, id, [{
    name: "main", defaultAction: "deny", chainPosition: "top",
    rules: [{ name: "allow-net", src: ["rn-net"], dst: ["any"], proto: "any", action: "allow" }],
  }]);
}

test("переименование сети обновляет фильтр связи и правила", async ({ page, request }) => {
  const id = await freshDraft(request, "rename-net");
  await arrangeConnected(request, id);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/networks");

  const row = page.locator("tbody tr", { hasText: "rn-net" });
  await row.locator(".icon-btn.edit").click();
  const dialog = page.locator("dialog.modal");
  await expect(dialog).toBeVisible();
  await dialog.locator('[placeholder="office"]').fill("rn-net-2");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();

  const doc = await getTopology(request, id);
  const net = doc.topology.networks.find((n) => n.name === "rn-net-2");
  expect(net, "сеть переименована").toBeTruthy();
  expect(net.subnets).toEqual(["rn-sub"]);
  expect(doc.topology.links[0].filter.aExports).toEqual(["rn-net-2"]);
  const rules = await getRules(request, id);
  expect(rules.chains[0].rules[0].src).toEqual(["rn-net-2"]);
});

test("переименование одиночной подсети", async ({ page, request }) => {
  const id = await freshDraft(request, "rename-sub");
  await putSubnets(request, id, [{ name: "rs-lan", cidr: "10.5.0.0/24" }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");

  const row = page.locator("tbody tr", { hasText: "rs-lan" });
  await row.locator(".icon-btn.edit").click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office-lan"]').fill("rs-lan-2");
  await dialog.getByRole("button", { name: "Сохранить" }).click();

  await expect.poll(async () => (await getSubnets(request, id)).subnets.map((s) => s.name), {
    timeout: 5_000,
  }).toContain("rs-lan-2");
});

test("переименование набора, используемого правилом, блокируется guard'ом", async ({ page, request }) => {
  const id = await freshDraft(request, "rename-set");
  await putSubnets(request, id, [{ name: "rset-sub", cidr: "10.7.0.0/24" }]);
  await putTopology(request, id, {
    devices: [],
    links: [],
    networks: [{ name: "rset-net", subnets: ["rset-sub"] }],
    sets: [{ name: "rset-set", subnets: ["rset-sub"] }],
    unions: [],
  });
  await putRules(request, id, [{
    name: "main", defaultAction: "deny", chainPosition: "top",
    rules: [{ name: "from-set", src: ["rset-set"], dst: ["any"], proto: "any", action: "allow" }],
  }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/sets");

  const row = page.locator("tbody tr", { hasText: "rset-set" });
  await row.locator(".icon-btn.edit").click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="blocked"]').fill("rset-set-2");
  await dialog.getByRole("button", { name: "Сохранить" }).click();

  await expect(page.locator("#error-banner")).toContainText('set "rset-set" is still used by rule "from-set"');
  await expect(dialog).toBeHidden();
  const doc = await getTopology(request, id);
  expect(doc.topology.sets.map((s) => s.name)).toContain("rset-set");
  const rules = await getRules(request, id);
  expect(rules.chains[0].rules[0].src).toContain("rset-set");
});

test.fixme("переименование подсети-члена сети обновляет список подсетей сети", async ({ page, request }) => {
  const id = await freshDraft(request, "rename-nested-sub");
  await putSubnets(request, id, [{ name: "rns-sub", cidr: "10.8.0.0/24" }]);
  await op(request, id, {
    kind: "create-network", network: { name: "rns-net", subnets: ["rns-sub"] },
  });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");

  const row = page.locator("tbody tr", { hasText: "rns-sub" });
  await row.locator(".icon-btn.edit").click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office-lan"]').fill("rns-sub-2");
  await dialog.getByRole("button", { name: "Сохранить" }).click();

  const doc = await getTopology(request, id);
  expect(doc.topology.networks[0].subnets).toEqual(["rns-sub-2"]);
});
