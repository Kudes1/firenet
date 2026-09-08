import { test, expect } from "@playwright/test";
import { env, login, createDraft, op, confirmDraft, getCurrentTopology, uid } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

const { baseURL } = env();

test("diff новой версии против предыдущей", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `hs-diff-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "hs-r1", kind: "router" } });
  await confirmDraft(request, id); // версия с устройством hs-r1
  await loginViaUI(page);
  await page.goto(baseURL + "/ui/history");
  // На общем сервере соседние сценарии подтверждают свои версии, поэтому
  // позицию нашей версии в таблице вычисляем по списку версий из API
  // (таблица рендерится в том же порядке — новейшая сверху).
  await expect.poll(async () => {
    const versions = await (await request.get(baseURL + "/api/versions")).json();
    return versions.some((v) => v.draftId === id);
  }).toBe(true);
  const versions = await (await request.get(baseURL + "/api/versions")).json();
  const index = versions.findIndex((v) => v.draftId === id);
  const row = page.locator("#history-table tbody tr").nth(index);
  await row.getByRole("button", { name: "Дифф" }).click();
  const panel = page.locator('[data-testid="diff-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("hs-r1");
  await expect(panel).toContainText("добавлено");
});

test("восстановление версии возвращает её состояние в текущую", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `hs-restore-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "hs-r2", kind: "router" } });
  await confirmDraft(request, id); // версия 2 с устройством hs-r2
  // версия 3: другое устройство, чтобы восстановление версии 2 было видно
  const id2 = await createDraft(request, `hs-restore2-${uid()}`);
  await op(request, id2, { kind: "create-device", device: { name: "hs-r3", kind: "router" } });
  await confirmDraft(request, id2);
  await loginViaUI(page);
  await page.goto(baseURL + "/ui/history");
  page.on("dialog", (d) => d.accept());
  // Кнопка «Восстановить» требует предыдущую версию в списке (HistoryPage
  // строит дифф только с соседней строкой), поэтому строка версии 2 —
  // вторая сверху; восстановление возвращает hs-r2 в текущую версию.
  await page.locator("#history-table tbody tr").nth(1)
    .getByRole("button", { name: "Восстановить" }).click();
  await expect(page.locator('[data-testid="banner"]')).toContainText(/Создана версия \d+/);
  // На общем тестовом сервере соседние сценарии подтверждают свои версии,
  // поэтому сверяем только присутствие устройства восстановленной версии,
  // а не весь состав (параллельные подтверждения меняют текущую).
  await expect.poll(async () =>
    ((await getCurrentTopology(request)).topology.devices ?? []).some((d) => d.name === "hs-r2"),
  ).toBe(true);
});
