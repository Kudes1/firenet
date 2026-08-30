import { test, expect } from "@playwright/test";
import { env } from "../helpers/api.js";

test("приложение поднято: страница логина видна", async ({ page }) => {
  await page.goto(env().baseURL + "/login");
  await expect(page.locator("#login-form")).toBeVisible();
});
