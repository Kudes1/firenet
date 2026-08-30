import { test, expect } from "@playwright/test";
import { env, login, createDraft, op, confirmDraft, getCurrentTopology, uid } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

const { baseURL } = env();

test("diff новой версии против предыдущей", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `hs-diff-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "hs-r1", kind: "router" } });
  await confirmDraft(request, id); // версия 2 с устройством
  await loginViaUI(page);
  await page.goto(baseURL + "/ui/history");
  const me = await (await request.get(baseURL + "/api/me")).json();
  const row = page.locator("#history-table tbody tr").first(); // новейшая — версия 2
  await expect(row).toContainText(me.id); // confirmedBy — id админа
  await row.getByRole("button", { name: "Дифф" }).click();
  const panel = page.locator("#diff-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("hs-r1");
  await expect(panel).toContainText("добавлено");
});

test("восстановление пустой версии опустошает текущую", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `hs-restore-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "hs-r2", kind: "router" } });
  await confirmDraft(request, id); // версия 2 с устройством
  await loginViaUI(page);
  await page.goto(baseURL + "/ui/history");
  page.on("dialog", (d) => d.accept());
  // версия 1 (пустая bootstrap) — последняя строка
  await page.locator("#history-table tbody tr").last()
    .getByRole("button", { name: "Восстановить" }).click();
  await expect(page.locator("#error-banner")).toContainText(/Создана версия \d+/);
  const doc = await getCurrentTopology(request);
  expect(doc.topology.devices ?? []).toEqual([]); // пустой срез сериализуется как null
});
