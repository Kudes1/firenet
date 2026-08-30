import { test, expect } from "@playwright/test";
import { login, createDraft, op, putRules, putSubnets } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function freshDraft(request, name) {
  await login(request);
  return createDraft(request, `${name}-${uid()}`);
}

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
  // Панель пути открыта по умолчанию: клик по инструменту — это toggle.
  if (await page.locator("#diag-panel").isHidden()) await page.locator("#diag-tool-path").click();
  await expect(page.locator("#diag-panel")).toBeVisible();
  await page.locator("#diag-src").fill("10.50.0.7");
  await page.locator("#diag-dst").fill("10.51.0.7");
  await page.getByRole("button", { name: "Диагностировать" }).click();
  const summary = page.locator("#diag-summary");
  await expect(summary).toContainText(new RegExp(`${a} → ${b}: путей 1`));
  await expect(page.locator("#diag-paths")).toContainText("Путь 1");
});

test("путь не найден без связи", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-none");
  const { a, b } = await arrangeTwoSites(request, id, { linked: false });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  if (await page.locator("#diag-panel").isHidden()) await page.locator("#diag-tool-path").click();
  await page.locator("#diag-src").fill("10.50.0.7");
  await page.locator("#diag-dst").fill("10.51.0.7");
  await page.getByRole("button", { name: "Диагностировать" }).click();
  await expect(page.locator("#diag-summary")).toContainText(": путей 0");
  await expect(page.locator(".diag-unreachable")).toContainText("Недостижимо: путей между подсетями нет.");
});

test("односторонняя доступность без mirror", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-half");
  await arrangeTwoSites(request, id, { mirror: false });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  if (await page.locator("#diag-panel").isHidden()) await page.locator("#diag-tool-path").click();
  await page.locator("#diag-src").fill("10.50.0.7");
  await page.locator("#diag-dst").fill("10.51.0.7");
  await page.getByRole("button", { name: "Диагностировать" }).click();
  await expect(page.locator(".diag-halfpath")).toContainText("Доступность в одну сторону");
});

test("распространение сети", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-spread");
  await arrangeTwoSites(request, id);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  await page.locator("#diag-tool-spread").click();
  await expect(page.locator("#spread-panel")).toBeVisible();
  await page.locator("#spread-src").fill("10.50.0.7");
  // Esc закрывает выпадающий список подсказок, иначе он перекрывает submit.
  await page.locator("#spread-src").press("Escape");
  await page.getByRole("button", { name: "Показать распространение" }).click();
  await expect(page.locator("#spread-summary")).toContainText(/Достижимо \d+ из \d+ подсетей/);
});
