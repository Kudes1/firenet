import { test, expect } from "@playwright/test";
import { login, createDraft, op, confirmDraft, getLayout } from "../helpers/api.js";
import { loginViaUI, openWithDraft, openCurrentVersion, dragNode } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

test("перетаскивание узла сохраняет позицию", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `ce-drag-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "cd-r1", kind: "router" } });
  await op(request, id, { kind: "set-device-position", deviceName: "cd-r1", position: { x: 400, y: 300 } });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");
  // центр узла: позиция (400,300) + (DEVICE_W/2=70, DEVICE_H/2=30)
  await dragNode(page, { x: 470, y: 330 }, { x: 570, y: 430 });
  await expect.poll(async () => (await getLayout(request, id)).devices["cd-r1"], { timeout: 5_000 })
    .toEqual({ x: 500, y: 400 });
  // после перезагрузки узел на новом месте: клик по центру выделяет
  await page.reload();
  await page.locator("#topo-canvas").click({ position: { x: 570, y: 430 } });
  await expect(page.locator("#topo-delete")).toBeEnabled();
});

test("текущая версия открыта только для чтения", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `ce-ro-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "ce-ro-r1", kind: "router" } });
  await confirmDraft(request, id);
  await loginViaUI(page);
  await openCurrentVersion(page, "/ui/subnets");
  await expect(page.locator(".draft-banner-readonly")).toContainText(/Только чтение — версия \d+/);
  // правка из read-only: сервер/клиент отклоняют, пользователь видит баннер
  await page.getByRole("button", { name: "+ подсеть" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office-lan"]').fill("ce-ro-sub");
  await dialog.locator('[placeholder="10.0.0.0/24"]').fill("10.60.0.0/24");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.locator("#error-banner")).toContainText("Только чтение");
});

test("поиск находит узел и центрирует камеру, клик выделяет", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `ce-search-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "ce-s-r1", kind: "router" } });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");
  await page.locator("#topo-search-toggle").click();
  await page.locator("#topo-search").fill("ce-s-r1");
  await page.keyboard.press("Enter");
  // Enter центрирует камеру на совпадении (твин 180мс); выделение — клик по подсвеченному узлу
  await page.waitForTimeout(300);
  const box = await page.locator("#topo-canvas").boundingBox();
  await page.locator("#topo-canvas").click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.locator("#topo-delete")).toBeEnabled();
});
