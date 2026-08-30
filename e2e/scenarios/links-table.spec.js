import { test, expect } from "@playwright/test";
import { op, getTopology, freshDraft } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

test("переключение фильтра связи из таблицы связей", async ({ page, request }) => {
  const id = await freshDraft(request, "lt-filter");
  await op(request, id, { kind: "create-device", device: { name: "lta-r1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "lta-r2", kind: "router" } });
  await op(request, id, {
    kind: "create-link",
    link: { a: { device: "lta-r1" }, b: { device: "lta-r2" } },
  });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/links");
  const row = page.locator("tbody tr").first();
  await expect(row).toContainText("обычная");
  await row.getByRole("button", { name: "Сделать фильтрованной" }).click();
  await expect.poll(async () => (await getTopology(request, id)).topology.links[0].filter)
    .toEqual({ aExports: [], bExports: [] });
  await row.getByRole("button", { name: "Вернуть обычную" }).click();
  await expect.poll(async () => (await getTopology(request, id)).topology.links[0].filter)
    .toBeUndefined();
});
