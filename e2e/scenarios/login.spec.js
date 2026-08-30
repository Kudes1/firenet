import { test, expect } from "@playwright/test";
import { env } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

test("неверный пароль показывает ошибку", async ({ page }) => {
  await page.goto(env().baseURL + "/login");
  await page.locator("#login-form input[name=username]").fill("e2e-admin");
  await page.locator("#login-form input[name=password]").fill("wrong-password");
  await page.locator("#login-form button[type=submit]").click();
  await expect(page.locator("#login-error")).toHaveText("Неверный логин или пароль");
});

test("верные креды ведут на topology", async ({ page }) => {
  await loginViaUI(page);
  await expect(page).toHaveURL(/\/ui\/topology$/);
});
