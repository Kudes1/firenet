import { expect } from "@playwright/test";
import { env, getTopology } from "./api.js";

export async function loginViaUI(page, creds) {
  const c = creds || env().admin;
  await page.goto(env().baseURL + "/login");
  await page.locator('[data-testid="login-form"] input[name=username]').fill(c.username);
  await page.locator('[data-testid="login-form"] input[name=password]').fill(c.password);
  await page.locator('[data-testid="login-form"] button[type=submit]').click();
  await page.waitForURL(/\/ui\/topology$/);
}

export async function openWithDraft(page, draftId, path) {
  await page.addInitScript((id) => {
    localStorage.setItem("ui.draft.lastId", id);
    sessionStorage.setItem("ui.draft.id", id);
  }, draftId);
  await page.goto(env().baseURL + path);
  await expect(page.locator('[data-testid="draft-banner"].draft-banner-editing')).toBeVisible();
}

export async function openTablePage(page, draftId, path) {
  await page.addInitScript((id) => {
    localStorage.setItem("ui.draft.lastId", id);
    sessionStorage.setItem("ui.draft.id", id);
  }, draftId);
  await page.goto(env().baseURL + path);
}

export async function openCurrentVersion(page, path) {
  await page.goto(env().baseURL + path);
}

// Канва React Flow: клик по панели в мировых координатах. Камера по
// умолчанию (x=0,y=0,z=1) переводит мировые координаты в экранные 1:1,
// поэтому position достаточно; zoom-твины камеры не используются.
export function canvasClick(page, x, y, opts = {}) {
  return page.locator('[data-testid="topo-canvas"] .react-flow__pane').click({ position: { x, y }, ...opts });
}

// drag по канве: from/to — экранные координаты относительно канваса.
// Используется для переноса узла: начинать нужно с тела узла.
export async function dragNode(page, from, to) {
  const box = await page.locator('[data-testid="topo-canvas"]').boundingBox();
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 5 });
  await page.mouse.up();
}

export function activateTool(page, tool) {
  return page.locator(`[data-testid="tool-${tool}"]`).click();
}

// Инструменты device/network создают узел кликом по панели; имя генерирует
// редактор (легаси-попапа с вводом имени нет). Имя извлекается из testid
// узла (rf__node-device:<name> / rf__node-network:<name>), а не из текста.
export async function createDeviceNode(page, at) {
  await activateTool(page, "device");
  const before = await nodeIds(page);
  await canvasClick(page, at.x, at.y);
  await expect
    .poll(() => nodeIds(page), { timeout: 5_000, message: "новое устройство не появилось на канве" })
    .not.toEqual(before);
  return diffNames(before, await nodeIds(page)).map(stripKind).at(-1);
}

export async function createNetworkNode(page, at) {
  await activateTool(page, "network");
  const before = await nodeIds(page);
  await canvasClick(page, at.x, at.y);
  await expect
    .poll(() => nodeIds(page), { timeout: 5_000, message: "новая сеть не появилась на канве" })
    .not.toEqual(before);
  return diffNames(before, await nodeIds(page)).map(stripKind).at(-1);
}

async function nodeIds(page) {
  return page.locator('[data-testid="topo-canvas"] .react-flow__node')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-id")));
}

// data-id узла — «device:<имя>» / «network:<имя>»; helper возвращает имя.
function stripKind(id) {
  return id.replace(/^(device|network):/, "");
}

function diffNames(before, after) {
  return after.filter((n) => !before.includes(n));
}

// Связь: connect-инструмент, клик по телам двух узлов (устройств).
export async function linkDevices(page, a, b) {
  await activateTool(page, "connect");
  await page.locator(`[data-testid="rf__node-device:${a}"] .react-flow__handle.source`).click();
  await page.locator(`[data-testid="rf__node-device:${b}"] .react-flow__handle.target`).click();
}

export async function waitTopology(request, draftId, predicate) {
  await expect
    .poll(async () => {
      try { return predicate(await getTopology(request, draftId)); }
      catch { return false; }
    }, { timeout: 5_000, message: "draft topology не достигла ожидаемого состояния" })
    .toBe(true);
}
