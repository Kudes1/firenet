import { test, expect } from "@playwright/test";
import { env, login, createDraft, op, registerUser, getVersions, uid, userCreds } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

test("создание черновика формой", async ({ page }) => {
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  const name = `df-form-${uid()}`;
  await page.locator("#create-draft-form input[name=name]").fill(name);
  await page.locator("#create-draft-form button[type=submit]").click();
  const row = page.locator("#drafts-table tbody tr", { hasText: name });
  await expect(row).toBeVisible();
  // API reports owner as the user's UUID, not the username.
  const list = await (await page.request.get(env().baseURL + "/api/drafts")).json();
  await expect(row).toContainText(list.find((d) => d.name === name).owner);
});

test("«Открыть» переключает черновик", async ({ page, request }) => {
  const name = `df-open-${uid()}`;
  await login(request);
  await createDraft(request, name);
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  await page.locator("#drafts-table tbody tr", { hasText: name })
    .getByRole("button", { name: "Открыть" }).click();
  await page.waitForURL(/\/ui\/topology$/);
  await expect(page.locator(".draft-banner-editing")).toContainText(name);
});

test("«Изменения» показывает diff черновика", async ({ page, request }) => {
  const name = `df-diff-${uid()}`;
  await login(request);
  const id = await createDraft(request, name);
  await op(request, id, { kind: "create-device", device: { name: "df-r1", kind: "router" } });
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  await page.locator("#drafts-table tbody tr", { hasText: name })
    .getByRole("button", { name: "Изменения" }).click();
  const panel = page.locator("#diff-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("df-r1");
  await expect(panel).toContainText("добавлено");
});

test("удаление черновика", async ({ page, request }) => {
  const name = `df-del-${uid()}`;
  await login(request);
  await createDraft(request, name);
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  page.on("dialog", (d) => d.accept());
  await page.locator("#drafts-table tbody tr", { hasText: name })
    .getByRole("button", { name: "Удалить" }).click();
  await expect(page.locator("#drafts-table tbody tr", { hasText: name })).toHaveCount(0);
});

test("admin подтверждает черновик в новую версию", async ({ page, request }) => {
  const name = `df-confirm-${uid()}`;
  await login(request);
  const id = await createDraft(request, name);
  await op(request, id, { kind: "create-device", device: { name: "df-c-r1", kind: "router" } });
  const before = await getVersions(request);
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  await page.locator("#drafts-table tbody tr", { hasText: name })
    .getByRole("button", { name: "Изменения" }).click();
  await expect(page.locator("#confirm-btn")).toBeVisible();
  await page.locator("#confirm-btn").click();
  await expect(page.locator("#error-banner")).toContainText(/Черновик подтверждён как версия \d+/);
  await expect.poll(async () => (await getVersions(request)).length)
    .toBe(before.length + 1);
});

test("не-admin: подтверждение недоступно", async ({ page, request }) => {
  const creds = userCreds();
  await login(request);
  await registerUser(request, creds);
  await loginViaUI(page, creds);
  const id = await createDraft(page.request, `df-own-${uid()}`);
  await page.goto(env().baseURL + "/ui/drafts");
  await expect(page.locator("#all-toggle")).toBeHidden();
  await page.locator("#drafts-table tbody tr", { hasText: "df-own-" })
    .getByRole("button", { name: "Изменения" }).click();
  await expect(page.locator("#confirm-btn")).toBeHidden();
  const res = await page.request.post(`${env().baseURL}/api/drafts/${id}/confirm`, { data: {} });
  expect(res.status()).toBe(403);
});
