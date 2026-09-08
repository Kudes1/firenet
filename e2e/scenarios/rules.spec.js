import { test, expect } from "@playwright/test";
import { getRules, putRules, putSubnets, freshDraft } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

// Панель замечаний (position: fixed) перекрывает правый верх страницы,
// когда линтер нашёл проблемы. Закрываем её крестиком, если она открылась
// (закрытие прячет панель до следующего «Проверить»).
async function closeLintPanel(page) {
  const panel = page.locator('[data-testid="lint-panel"]');
  try {
    await panel.waitFor({ state: "visible", timeout: 2_000 });
  } catch {
    return; // находок нет — панель не открывалась
  }
  await panel.locator(".lint-panel-close").click();
  await expect(panel).toBeHidden();
}

test("создание цепочки и её параметры", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-chain");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  await page.locator(".chain-tab-add").click(); // addChain сразу открывает параметры
  await page.locator(".rules-settings-group label", { hasText: "Действие по умолчанию" })
    .locator("select").selectOption("allow");
  await page.locator(".rules-settings-group label", { hasText: "Имя" })
    .locator("input").fill("rc-chain");
  await page.locator(".settings-edit-actions").getByRole("button", { name: "Сохранить" }).click();
  await expect.poll(async () => (await getRules(request, id)).chains).toContainEqual(
    expect.objectContaining({ name: "rc-chain", defaultAction: "allow", rules: [] }),
  );
});

test("создание правила с эндпоинтами", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-rule");
  await putSubnets(request, id, [{ name: "rr-sub", cidr: "10.34.0.0/24" }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  await page.getByRole("button", { name: "+ Правило" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator("label", { hasText: "Имя" }).locator("input").fill("rr-allow");
  // Combo источников: первый под label Src, получателя — под label Dst.
  const srcCombo = dialog.locator("label", { hasText: "Src" }).locator("input").last();
  await srcCombo.fill("rr-sub");
  await dialog.locator("label", { hasText: "Src" }).locator(".member-suggestion", { hasText: "rr-sub" }).click();
  const dstCombo = dialog.locator("label", { hasText: "Dst" }).locator("input").last();
  await dstCombo.click();
  await dialog.locator("label", { hasText: "Dst" }).locator(".member-suggestion", { hasText: /^any$/ }).click();
  await dialog.locator("label", { hasText: "Действие" }).locator("select").selectOption("allow");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.locator("dialog.modal[open]")).toHaveCount(0);
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
  await closeLintPanel(page);
  await page.locator('[data-testid="rules-table"] tbody tr', { hasText: "rd-keep" }).locator(".icon-btn.delete").click();
  await expect.poll(async () => (await getRules(request, id)).chains.flatMap((c) => c.rules.map((r) => r.name)))
    .not.toContain("rd-keep");
  await page.locator(".chain-tab", { hasText: "rd-chain" }).locator(".chain-tab-remove").click();
  await expect.poll(async () => (await getRules(request, id)).chains.map((c) => c.name))
    .not.toContain("rd-chain");
});

test("«Проверить» находит замечания и закрывается крестиком", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-lint");
  await putRules(request, id, [
    {
      name: "main", defaultAction: "deny", chainPosition: "top",
      rules: [{ name: "rld-broad", src: ["any"], dst: ["any"], proto: "any", action: "deny" }],
    },
  ]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  // Панель не показывается до явного «Проверить».
  await expect(page.locator('[data-testid="lint-panel"]')).toBeHidden();
  await page.getByRole("button", { name: "Проверить" }).click();
  const panel = page.locator('[data-testid="lint-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("rld-broad");
  // Крестик прячет панель.
  await closeLintPanel(page);
});
