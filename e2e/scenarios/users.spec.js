import { test, expect } from "@playwright/test";
import { env, login, registerUser, uid, userCreds } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

test("admin создаёт пользователя формой", async ({ page }) => {
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/users");
  await expect(page.locator("#users-table")).toBeVisible();
  const username = `e2e-form-${uid()}`;
  await page.locator("#create-user-form input[name=username]").fill(username);
  await page.locator("#create-user-form input[name=password]").fill("e2e-form-pass-1");
  await page.locator("#create-user-form select[name=role]").selectOption("user");
  await page.locator("#create-user-form button[type=submit]").click();
  await expect(page.locator("#users-table tbody tr", { hasText: username })).toBeVisible();
  await expect(page.locator("#users-table tbody tr", { hasText: username })).toContainText("user");
});

test("admin удаляет пользователя", async ({ page, request }) => {
  const creds = userCreds();
  await login(request);
  await registerUser(request, creds);
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/users");
  const row = page.locator("#users-table tbody tr", { hasText: creds.username });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Удалить" }).click();
  await expect(row).toHaveCount(0);
});

test("не-admin видит отказ доступа", async ({ page, request }) => {
  const creds = userCreds();
  await login(request);
  await registerUser(request, creds);
  await loginViaUI(page, creds);
  await page.goto(env().baseURL + "/ui/users");
  await expect(page.locator("#access-denied")).toBeVisible();
  await expect(page.locator("#users-table")).toBeHidden();
  await expect(page.locator("#create-user-form")).toBeHidden();
});

test("logout возвращает на страницу логина", async ({ page }) => {
  await loginViaUI(page);
  await page.locator(".logout-btn").click();
  await page.waitForURL(/\/login/);
  await page.goto(env().baseURL + "/ui/topology");
  // expect-поллинг вместо waitForURL: клиентский редирект на /login
  // абортит навигацию (ERR_ABORTED), waitForURL на этом флакует.
  await expect(page).toHaveURL(/\/login/);
});
