import { test, expect } from "@playwright/test";
import { op, getSubnets, getTopology, putSubnets, freshDraft, uid } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

test("создание подсети формой", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-sub");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");
  await page.getByRole("button", { name: "+ подсеть" }).click();
  const dialog = page.locator("dialog.modal");
  await expect(dialog).toBeVisible();
  const name = `tcf-${uid()}`;
  await dialog.locator('[placeholder="office-lan"]').fill(name);
  await dialog.locator('[placeholder="10.0.0.0/24"]').fill("10.31.0.0/24");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.locator("#error-banner")).toContainText("Подсети сохранены");
  await expect.poll(async () => (await getSubnets(request, id)).subnets.map((s) => s.name))
    .toContain(name);
});

test("сервер отвергает подсеть с плохим CIDR", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-bad");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");
  await page.getByRole("button", { name: "+ подсеть" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office-lan"]').fill("tcf-bad-sub");
  await dialog.locator('[placeholder="10.0.0.0/24"]').fill("10.0.0");
  // draftHint не ловит формат — кнопка активна; сервер отвечает ошибкой
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.locator("#error-banner")).toContainText("Ошибка сохранения");
  // API сериализует пустые коллекции как null
  await expect.poll(async () => ((await getSubnets(request, id)).subnets || []).map((s) => s.name))
    .not.toContain("tcf-bad-sub");
});

test("добавление подсети-члена в сеть через модалку", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-net");
  await putSubnets(request, id, [{ name: "tcf-sub", cidr: "10.32.0.0/24" }]);
  await op(request, id, { kind: "create-network", network: { name: "tcf-net", subnets: [], attach: [] } });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/networks");
  const row = page.locator("tbody tr", { hasText: "tcf-net" });
  await row.locator(".icon-btn.edit").click();
  const dialog = page.locator("dialog.modal");
  const combo = dialog.locator('[placeholder="все подсети — начните вводить для поиска"]');
  await combo.fill("tcf-sub");
  await dialog.locator(".member-suggestion", { hasText: "tcf-sub" }).click();
  await expect(dialog.locator(".member-row", { hasText: "tcf-sub" })).toBeVisible();
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const doc = await getTopology(request, id);
    return doc.topology.networks.find((n) => n.name === "tcf-net")?.subnets;
  }, { timeout: 5_000 }).toContain("tcf-sub");
});

test("создание набора с подсетью и адресом", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-set");
  await putSubnets(request, id, [{ name: "tcf-s-sub", cidr: "10.33.0.0/24" }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/sets");
  await page.getByRole("button", { name: "+ набор" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="blocked"]').fill(`tcf-set-${uid()}`);
  const combo = dialog.locator('[placeholder="все подсети — начните вводить для поиска"]');
  await combo.fill("tcf-s-sub");
  await dialog.locator(".member-suggestion", { hasText: "tcf-s-sub" }).click();
  const addr = dialog.locator('[placeholder="10.0.0.5 или 10.0.0.5/32 — Enter добавляет"]');
  await addr.fill("10.33.0.7/32");
  await addr.press("Enter");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const doc = await getTopology(request, id);
    return doc.topology.sets.find((s) => s.name.startsWith("tcf-set-"));
  }, { timeout: 5_000 }).toMatchObject({ subnets: ["tcf-s-sub"], addresses: ["10.33.0.7/32"] });
});

test("создание и удаление объединения", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-union");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/unions");
  await page.getByRole("button", { name: "+ объединение" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office"]').fill("tcf-union");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await getTopology(request, id)).topology.unions.map((u) => u.name))
    .toContain("tcf-union");
  page.on("dialog", (d) => d.accept());
  await page.locator("tbody tr", { hasText: "tcf-union" }).locator(".icon-btn.delete").click();
  await expect.poll(async () => (await getTopology(request, id)).topology.unions || [], { timeout: 5_000 })
    .toHaveLength(0);
});
