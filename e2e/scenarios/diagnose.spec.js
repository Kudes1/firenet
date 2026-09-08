import { test, expect } from "@playwright/test";
import { op, putRules, putSubnets, freshDraft, uid } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

async function arrangeTwoSites(request, id, { linked = true, mirror = true } = {}) {
  const a = `dg-a-${uid()}`, b = `dg-b-${uid()}`;
  await putSubnets(request, id, [
    { name: a, cidr: "10.50.0.0/24" },
    { name: b, cidr: "10.51.0.0/24" },
  ]);
  await op(request, id, { kind: "create-device", device: { name: "dg-r1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "dg-r2", kind: "router" } });
  await op(request, id, { kind: "create-network", network: { name: `${a}-net`, subnets: [a], attach: [{ device: "dg-r1" }] } });
  await op(request, id, { kind: "create-network", network: { name: `${b}-net`, subnets: [b], attach: [{ device: "dg-r2" }] } });
  if (linked) {
    await op(request, id, {
      kind: "create-link",
      link: { a: { device: "dg-r1" }, b: { device: "dg-r2" } },
    });
  }
  await putRules(request, id, [{
    name: "main", defaultAction: "deny", chainPosition: "top",
    rules: [{ name: "dg-allow", src: [a], dst: [b], proto: "any", action: "allow", mirror }],
  }]);
  return { a, b };
}

test("путь найден между двумя подсетями", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-found");
  const { a, b } = await arrangeTwoSites(request, id);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  const panel = page.locator('[data-testid="diag-panel"]');
  await expect(panel).toBeVisible();
  await panel.locator("label", { hasText: "Источник" }).locator("input").fill("10.50.0.7");
  await panel.locator("label", { hasText: "Назначение" }).locator("input").fill("10.51.0.7");
  await panel.getByRole("button", { name: "Проверить путь" }).click();
  const report = page.locator('[data-testid="diag-report"]');
  await expect(report).toContainText(new RegExp(`${a} → ${b}: путей 1`));
  await expect(report.locator(".diag-path").first()).toContainText("dg-r1");
});

test("путь не найден без связи", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-none");
  const { a, b } = await arrangeTwoSites(request, id, { linked: false });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  const panel = page.locator('[data-testid="diag-panel"]');
  await expect(panel).toBeVisible();
  await panel.locator("label", { hasText: "Источник" }).locator("input").fill("10.50.0.7");
  await panel.locator("label", { hasText: "Назначение" }).locator("input").fill("10.51.0.7");
  await panel.getByRole("button", { name: "Проверить путь" }).click();
  await expect(page.locator('[data-testid="diag-report"]')).toContainText(": путей 0");
  await expect(page.locator(".diag-unreachable")).toContainText("Путей нет.");
});

test("односторонняя доступность без mirror", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-half");
  await arrangeTwoSites(request, id, { mirror: false });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  const panel = page.locator('[data-testid="diag-panel"]');
  await expect(panel).toBeVisible();
  await panel.locator("label", { hasText: "Источник" }).locator("input").fill("10.50.0.7");
  await panel.locator("label", { hasText: "Назначение" }).locator("input").fill("10.51.0.7");
  await panel.getByRole("button", { name: "Проверить путь" }).click();
  await expect(page.locator(".diag-halfpath")).toContainText("Доступность только в одну сторону");
});

test("распространение сети", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-spread");
  await arrangeTwoSites(request, id);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  await page.locator('[data-testid="tool-spread"]').click();
  const spread = page.locator('[data-testid="spread-panel"]');
  await expect(spread).toBeVisible();
  await spread.locator("input").fill("10.50.0.7");
  await spread.getByRole("button", { name: "Проверить доступность" }).click();
  await expect(page.locator('[data-testid="spread-report"]')).toContainText(/Достижимо \d+ из \d+ подсетей/);
});
