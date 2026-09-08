import { test, expect } from "@playwright/test";
import { login, createDraft, op, confirmDraft, getLayout, uid, env } from "../helpers/api.js";
import { loginViaUI, openWithDraft, openCurrentVersion } from "../helpers/ui.js";

test("перетаскивание узла сохраняет позицию", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `ce-drag-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "cd-r1", kind: "router" } });
  await op(request, id, { kind: "set-device-position", deviceName: "cd-r1", position: { x: 400, y: 300 } });
  await op(request, id, { kind: "set-camera", camera: { x: 0, y: 0, z: 1 } });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");

  // React Flow может применить fitView поверх сохранённой камеры (данные
  // приходят асинхронно), поэтому zoom вычисляем по фактической ширине узла.
  const node = page.locator('[data-testid="topo-canvas"] [data-testid="rf__node-device:cd-r1"]');
  await expect(node).toBeVisible();
  const box = await node.boundingBox();
  const zoom = box.width / 140; // DEVICE_W = 140

  // Хватаемся за тело узла (+30,+20 от его угла) и тащим на (+100,+100) экрана.
  await page.mouse.move(box.x + 30, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 120, { steps: 5 });
  await page.mouse.up();

  // Ожидаемая мировая позиция — по фактическому экранному смещению узла:
  // React Flow съедает первый шаг drag'а (nodeDragThreshold), поэтому
  // вычисляем дельту по boundingBox до и после.
  const box2 = await node.boundingBox();
  await expect.poll(async () => (await getLayout(request, id)).devices["cd-r1"], { timeout: 5_000 })
    .toEqual({ x: 400 + (box2.x - box.x) / zoom, y: 300 + (box2.y - box.y) / zoom });

  // после перезагрузки узел на новом месте: клик по его телу выделяет
  await page.reload();
  await page.locator('[data-testid="topo-canvas"]')
    .locator('[data-testid="rf__node-device:cd-r1"]').click({ position: { x: 30, y: 20 } });
  await expect(page.locator('[data-testid="topo-delete"]')).toBeEnabled();
});

test("текущая версия открыта только для чтения", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `ce-ro-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "ce-ro-r1", kind: "router" } });
  await confirmDraft(request, id);
  await loginViaUI(page);
  await openCurrentVersion(page, "/ui/subnets");
  await expect(page.locator(".draft-banner-readonly")).toContainText(/Только чтение — версия \d+/);
  // правка из read-only: клиент отклоняет с уведомлением, форма не открывается
  // (Modal всегда в DOM, но закрытый — без атрибута open)
  await page.getByRole("button", { name: "+ Подсеть" }).click();
  await expect(page.locator('[data-testid="banner"]')).toContainText("Только чтение");
  await expect(page.locator("dialog.modal[open]")).toHaveCount(0);
  // и на канве тоже: инструмент добавления не активируется
  await page.goto(env().baseURL + "/ui/topology");
  await page.locator('[data-testid="tool-device"]').click();
  await expect(page.locator('[data-testid="banner"]').first()).toContainText("Только чтение");
  await expect(page.locator('[data-testid="tool-device"]')).not.toHaveClass(/active/);
});

test("поиск подсвечивает узел, клик по нему выделяет", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `ce-search-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "ce-s-r1", kind: "router" } });
  await op(request, id, { kind: "set-device-position", deviceName: "ce-s-r1", position: { x: 400, y: 300 } });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");
  await page.locator('[data-testid="topo-search-toggle"]').click();
  await page.locator("#topo-search").fill("ce-s-r1");
  // поиск подсвечивает совпадение; выделение — клик по подсвеченному узлу
  const node = page.locator('[data-testid="topo-canvas"]')
    .locator('[data-testid="rf__node-device:ce-s-r1"]');
  await expect(node).toHaveClass(/search-hit/);
  await node.click({ position: { x: 30, y: 20 } });
  await expect(page.locator('[data-testid="topo-delete"]')).toBeEnabled();
});
