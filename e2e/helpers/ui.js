import { expect } from "@playwright/test";
import { env, getTopology } from "./api.js";

export async function loginViaUI(page) {
  const { admin } = env();
  await page.goto(env().baseURL + "/login");
  await page.locator("#login-form input[name=username]").fill(admin.username);
  await page.locator("#login-form input[name=password]").fill(admin.password);
  await page.locator("#login-form button[type=submit]").click();
  await page.waitForURL(/\/ui\/topology$/);
}

export async function openWithDraft(page, draftId, path) {
  await page.addInitScript((id) => {
    localStorage.setItem("firenet-last-draft-id", id);
    sessionStorage.setItem("firenet-draft-id", id);
  }, draftId);
  await page.goto(env().baseURL + path);
  await page.locator("#topo-canvas").waitFor();
}

export function activateTool(page, tool) {
  return page.locator(`#tool-${tool}`).click();
}

export function canvasClick(page, x, y, opts = {}) {
  return page.locator("#topo-canvas").click({ position: { x, y }, ...opts });
}

export async function createNode(page, name, at, kind = null) {
  await canvasClick(page, at.x, at.y);
  await expect(page.locator("#node-popover")).toBeVisible();
  await page.locator("#node-name-input").fill(name);
  if (kind) await page.locator("#node-kind-select").selectOption(kind);
  await page.locator("#node-name-form button[type=submit]").click();
  await expect(page.locator("#node-popover")).toBeHidden();
}

export async function waitTopology(request, draftId, predicate) {
  await expect
    .poll(async () => {
      try { return predicate(await getTopology(request, draftId)); }
      catch { return false; }
    }, { timeout: 5_000, message: "draft topology не достигла ожидаемого состояния" })
    .toBe(true);
}
