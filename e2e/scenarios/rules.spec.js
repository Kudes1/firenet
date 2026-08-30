import { test, expect } from "@playwright/test";
import { login, createDraft, getRules, putRules, putSubnets } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function freshDraft(request, name) {
  await login(request);
  return createDraft(request, `${name}-${uid()}`);
}

test("создание цепочки и её параметры", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-chain");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  await page.locator(".chain-tab-add").click(); // addChain сразу открывает параметры
  await page.locator(".rules-settings-group label", { hasText: "Действие" })
    .locator("select").selectOption("allow");
  await page.locator(".rules-settings-group input").fill("rc-chain");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect.poll(async () => (await getRules(request, id)).chains).toContainEqual(
    expect.objectContaining({ name: "rc-chain", defaultAction: "allow", rules: [] }),
  );
});

test("создание правила с эндпоинтами", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-rule");
  await putSubnets(request, id, [{ name: "rr-sub", cidr: "10.34.0.0/24" }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  await page.getByRole("button", { name: "+ правило" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office-to-dmz"]').fill("rr-allow");
  const srcField = dialog.locator(".modal-field", { hasText: "Src" }).first();
  await srcField.locator('[placeholder="имя, IP или CIDR — начните вводить"]').fill("rr-sub");
  await srcField.locator(".member-suggestion", { hasText: "rr-sub" }).click();
  const dstField = dialog.locator(".modal-field", { hasText: "Dst" }).first();
  await dstField.locator('[placeholder="имя, IP или CIDR — начните вводить"]').click();
  await dstField.locator(".member-suggestion", { hasText: /^any$/ }).click();
  await dialog.locator("label", { hasText: "Action" }).locator("select").selectOption("allow");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
  const allRules = (await getRules(request, id)).chains.flatMap((c) => c.rules);
  expect(allRules).toContainEqual(expect.objectContaining({
    name: "rr-allow", src: ["rr-sub"], dst: ["any"], action: "allow",
  }));
});

test("удаление правила и цепочки", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-del");
  await putRules(request, id, [
    {
      name: "main", defaultAction: "deny", chainPosition: "top",
      rules: [{ name: "rd-keep", src: ["any"], dst: ["any"], proto: "any", action: "deny" }],
    },
    {
      name: "rd-chain", defaultAction: "deny",
      rules: [{ name: "rd-drop", src: ["any"], dst: ["any"], proto: "any", action: "deny" }],
    },
  ]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  page.on("dialog", (d) => d.accept());
  await page.locator("tbody tr", { hasText: "rd-keep" }).locator(".icon-btn.delete").click();
  await expect.poll(async () => (await getRules(request, id)).chains.flatMap((c) => c.rules.map((r) => r.name)))
    .not.toContain("rd-keep");
  await page.locator(".chain-tab", { hasText: "rd-chain" }).locator(".chain-tab-remove").click();
  await expect.poll(async () => (await getRules(request, id)).chains.map((c) => c.name))
    .not.toContain("rd-chain");
});

test("«Проверить» на корректных правилах — находок нет", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-lint");
  await putRules(request, id, [{ name: "main", defaultAction: "deny", chainPosition: "top", rules: [] }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  await page.getByRole("button", { name: "Проверить" }).click();
  const panel = page.locator(".lint-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Находки линтера (0)");
  await expect(panel).toContainText("Проблем не найдено");
});
