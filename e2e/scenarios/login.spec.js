import { test, expect } from "@playwright/test";
import { env } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

test("неверный пароль показывает ошибку сервера", async ({ page }) => {
  await page.goto(env().baseURL + "/login");
  await page.locator('[data-testid="login-form"] input[name=username]').fill("e2e-admin");
  await page.locator('[data-testid="login-form"] input[name=password]').fill("wrong-password");
  await page.locator('[data-testid="login-form"] button[type=submit]').click();
  await expect(page.locator('[data-testid="login-error"]')).toHaveText("invalid username or password");
});

test("верные креды ведут на topology", async ({ page }) => {
  await loginViaUI(page);
  await expect(page).toHaveURL(/\/ui\/topology$/);
});
