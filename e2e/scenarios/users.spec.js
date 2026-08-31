import { test, expect } from "@playwright/test";
import { env, login, registerUser, uid, userCreds } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

test("admin создаёт пользователя формой", async ({ page }) => {
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/users");
  await page.getByRole("button", { name: "Добавить пользователя" }).click();
  const createDialog = page.locator("dialog.modal", { hasText: "Новый пользователь" });
  await expect(createDialog).toBeVisible();
  const username = `e2e-form-${uid()}`;
  await createDialog.locator('[placeholder="ivan"]').fill(username);
  await createDialog.locator("select").selectOption("user");
  await createDialog.getByRole("button", { name: "Создать" }).click();
  await expect(createDialog).toBeHidden();

  const inviteDialog = page.locator("dialog.modal", { hasText: "Ссылка для активации" });
  await expect(inviteDialog).toBeVisible();
  await inviteDialog.getByRole("button", { name: "Закрыть" }).click();

  const row = page.locator("tbody tr", { hasText: username });
  await expect(row).toBeVisible();
  await expect(row).toContainText("user");
  await expect(row).toContainText("Ожидает");
});

test("admin удаляет пользователя", async ({ page, request }) => {
  const creds = userCreds();
  await login(request);
  await registerUser(request, creds);
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/users");
  const row = page.locator("tbody tr", { hasText: creds.username });
  await expect(row).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await row.locator(".icon-btn.delete").click();
  await expect(row).toHaveCount(0);
});

test("не-admin видит отказ доступа", async ({ page, request }) => {
  const creds = userCreds();
  await login(request);
  await registerUser(request, creds);
  await loginViaUI(page, creds);
  await page.goto(env().baseURL + "/ui/users");
  await expect(page.getByText("Доступ только для администраторов")).toBeVisible();
  await expect(page.locator(".table-toolbar")).toBeHidden();
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
