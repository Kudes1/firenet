import { test, expect } from "@playwright/test";
import { login, createDraft, op, getLayout, uid } from "../helpers/api.js";
import {
  loginViaUI, openWithDraft, createDeviceNode, linkDevices, waitTopology,
} from "../helpers/ui.js";

async function freshDraft(page, request, name) {
  await login(request);
  // Имя уникально: иначе повторный прогон по той же БД даёт 409.
  const id = await createDraft(request, `${name}-${uid()}`);
  // Камера по умолчанию: мировые координаты == экранным, иначе fitView
  // подгонит масштаб и клики по канве попадут не туда.
  await op(request, id, { kind: "set-camera", camera: { x: 0, y: 0, z: 1 } });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");
  return id;
}

test("double click on link adds a bend point, drag moves it, second click removes it", async ({ page, request }) => {
  const id = await freshDraft(page, request, "link-waypoints");

  const r1 = await createDeviceNode(page, { x: 200, y: 200 });
  const r2 = await createDeviceNode(page, { x: 600, y: 200 });
  await linkDevices(page, r1, r2);
  await waitTopology(request, id, (doc) =>
    doc.topology.links.some((l) => l.a.device === r1 && l.b.device === r2));

  const pairKey = [r1, r2].sort().join("|");
  // layout пишется дебаунсом: опрашиваем мягко, без падения на отсутствующем
  // ключе (пока операция не доехала, links[pairKey] может быть undefined).
  const points = async () => (await getLayout(request, id)).links?.[pairKey]?.[0] ?? [];

  // Двойной клик по линии (центры узлов: +70 по x, +30 по y, линия y=230).
  // Клик адресуется координатами мыши, а не локатором path.link-hit:
  // Playwright считает path невидимым (getBoundingClientRect горизонтального
  // path в Chromium даёт height=0, а computeBox видит только площадь) —
  // locator.dblclick по пути не проходит ни при каких координатах. Реальный
  // ввод мышью в этой точке попадает в путь и проверяет тот же обработчик
  // handleDoubleClick, что и раньше.
  const canvas = await page.locator('[data-testid="topo-canvas"]').boundingBox();
  await page.mouse.dblclick(canvas.x + 470, canvas.y + 230);

  // Точка изгиба появилась на канве и сохранилась в layout.
  const handle = page.locator('[data-testid="topo-canvas"] [data-testid^="waypoint:"]');
  await expect(handle).toHaveCount(1, { timeout: 5_000 });
  await expect.poll(points, { timeout: 5_000 }).toHaveLength(1);
  const afterAdd = (await points())[0];

  // Drag точки изгиба.
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(points, { timeout: 5_000 }).not.toEqual([afterAdd]);

  // Повторный двойной клик по точке удаляет её.
  await handle.dblclick();
  await expect(handle).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(points, { timeout: 5_000 }).toHaveLength(0);
});
