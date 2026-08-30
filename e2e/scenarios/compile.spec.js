import { test, expect } from "@playwright/test";
import { op, putRules, putSubnets, freshDraft } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

async function arrangeLinkedDevices(request, id, prefix) {
  await op(request, id, { kind: "create-device", device: { name: `${prefix}-r1`, kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: `${prefix}-r2`, kind: "router" } });
  await op(request, id, {
    kind: "create-link",
    link: { a: { device: `${prefix}-r1` }, b: { device: `${prefix}-r2` } },
  });
}

test("компиляция выдаёт скрипты по устройствам", async ({ page, request }) => {
  const id = await freshDraft(request, "cp-ok");
  await arrangeLinkedDevices(request, id, "cp");
  // any→any попадает на все роутеры; без правил Compile возвращает пустой
  // список (роутеры без правил из вывода исключаются)
  await putRules(request, id, [{
    name: "main", defaultAction: "deny", chainPosition: "top",
    rules: [{ name: "cp-any", src: ["any"], dst: ["any"], proto: "any", action: "deny" }],
  }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/compile");
  await page.locator("#compile-run").click();
  const out = page.locator("#compile-output");
  await expect(out.locator("section.compile-device")).toHaveCount(2);
  await expect(out.locator("h2").first()).toHaveText("cp-r1");
  await expect(out.locator("pre").first()).toBeVisible();
  await expect(out.locator("a").first()).toContainText("Скачать");
});

test("компиляция молча опускает правило с недостижимым путём", async ({ page, request }) => {
  const id = await freshDraft(request, "cp-bad");
  await putSubnets(request, id, [
    { name: "cpb-a", cidr: "10.40.0.0/24" },
    { name: "cpb-b", cidr: "10.41.0.0/24" },
  ]);
  // два устройства без связи: физического пути a→b нет
  await op(request, id, { kind: "create-device", device: { name: "cpb-r1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "cpb-r2", kind: "router" } });
  await putRules(request, id, [{
    name: "main", defaultAction: "deny", chainPosition: "top",
    rules: [{ name: "cpb-allow", src: ["cpb-a"], dst: ["cpb-b"], proto: "any", action: "allow" }],
  }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/compile");
  await page.locator("#compile-run").click();
  // правило без физического пути никому не ставится; компилятор молча
  // возвращает пустой список — баннера нет (compiler.Compile, err == nil)
  await expect(page.locator("#error-banner")).toBeHidden();
  await expect(page.locator("#compile-output")).not.toContainText("cpb-r1");
});
