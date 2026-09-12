import { test, expect } from "@playwright/test";
import { login, createDraft, putSubnets, op } from "../helpers/api.js";
import {
  loginViaUI, openWithDraft, openTablePage, createDeviceNode, createNetworkNode, linkDevices, waitTopology,
} from "../helpers/ui.js";

const draftName = (name) => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function createSubnet(page, name, cidr) {
  await page.getByRole("button", { name: "+ Подсеть" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="lan"]').fill(name);
  await dialog.locator('[placeholder="10.0.0.0/24"]').fill(cidr);
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.locator("dialog.modal[open]")).toHaveCount(0);
}

async function addNetworkMember(page, network, subnet) {
  const row = page.locator("tbody tr", { hasText: network });
  await row.locator(".icon-btn.edit").click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator(".member-add input").fill(subnet);
  await dialog.getByRole("button", { name: new RegExp(`^${subnet} \\(`) }).click();
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.locator("dialog.modal[open]")).toHaveCount(0);
}

async function freshDraft(page, request, name) {
  await login(request);
  const id = await createDraft(request, draftName(name));
  // Камера по умолчанию: мировые координаты == экранным, иначе fitView
  // подгонит масштаб и клики по канве попадут не туда.
  await op(request, id, { kind: "set-camera", camera: { x: 0, y: 0, z: 1 } });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");
  await createSubnet(page, "lf-sub-a", "10.60.1.0/24");
  await createSubnet(page, "lf-sub-b", "10.60.2.0/24");
  return id;
}

async function arrangeLinkWithNetworks(page, id, request) {
  await openWithDraft(page, id, "/ui/topology");
  const r1 = await createDeviceNode(page, { x: 400, y: 300 });
  const r2 = await createDeviceNode(page, { x: 700, y: 300 });
  const netA = await createNetworkNode(page, { x: 400, y: 550 });
  const netB = await createNetworkNode(page, { x: 700, y: 550 });
  await linkDevices(page, r1, r2);
  // Сначала дожидаемся, что браузерный flush (дебаунс 400мс) подтвердил
  // связь: иначе API-операции ниже сменят ревизию, а следующий flush
  // браузера упадёт с CAS-конфликтом и перетрёт их.
  await waitTopology(request, id, (doc) => doc.topology.links?.length === 1);
  // Привязка сетей к устройствам — операцией через API: connect-инструмент
  // в React-версии создаёт только device-device связи.
  await op(request, id, { kind: "attach-network", networkName: netA, attach: { device: r1 } });
  await op(request, id, { kind: "attach-network", networkName: netB, attach: { device: r2 } });
  // Подсети-члены: без них сети «пустые», link-exports не находит
  // достижимых сущностей и комбобокс экспорта остаётся пустым.
  await op(request, id, { kind: "update-network", networkName: netA, network: { name: netA, subnets: ["lf-sub-a"], attach: [{ device: r1 }] } });
  await op(request, id, { kind: "update-network", networkName: netB, network: { name: netB, subnets: ["lf-sub-b"], attach: [{ device: r2 }] } });
  await waitTopology(request, id, (doc) => {
    const nets = doc.topology.networks;
    return doc.topology.links.length === 1
      && nets.every((n) => (n.attach || []).length === 1 && (n.subnets || []).length === 1);
  });
  await page.reload();
  await openWithDraft(page, id, "/ui/topology");
  return { r1, r2, netA, netB };
}

test("связь становится фильтрованной с экспортами через таблицу связей", async ({ page, request }) => {
  const id = await freshDraft(page, request, "link-filter");
  const { r1, r2, netA, netB } = await arrangeLinkWithNetworks(page, id, request);

  // Фильтр настраивается на странице «Связи»: контекстного меню канвы в
  // React-версии нет. «Фильтровать» переводит связь в фильтрованный режим
  // сразу (без модалки); экспорты задаются через «Изменить фильтр».
  await openTablePage(page, id, "/ui/links");
  const row = page.locator("tbody tr", { hasText: `${r1} ↔ ${r2}` });
  await row.getByRole("button", { name: "Фильтровать" }).click();
  await row.locator(".icon-btn.edit").click();
  const dialog = page.locator('dialog.modal[open]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`${r1} ↔ ${r2}`);

  // Кандидаты экспорта подгружаются с бэкенда (link-exports): сеть видна,
  // только когда она привязана к соответствующему устройству.
  const exportA = dialog.locator("fieldset", { hasText: r1 }).locator(".member-add input");
  await exportA.fill(netA);
  await dialog.locator("fieldset", { hasText: r1 }).locator(".member-suggestion", { hasText: netA }).click();
  const exportB = dialog.locator("fieldset", { hasText: r2 }).locator(".member-add input");
  await exportB.fill(netB);
  await dialog.locator("fieldset", { hasText: r2 }).locator(".member-suggestion", { hasText: netB }).click();

  await waitTopology(request, id, (doc) => {
    const f = doc.topology.links[0].filter;
    return !!f && f.aExports.includes(netA) && f.bExports.includes(netB);
  });
  // «Закрыть» встречается дважды: крестик в хедере (aria-label) и кнопка
  // в футере модалки — берём футер.
  await dialog.locator(".modal-footer").getByRole("button", { name: "Закрыть" }).click();

  // Возврат в обычную из таблицы.
  await row.getByRole("button", { name: "Обычная" }).click();
  await waitTopology(request, id, (doc) => doc.topology.links[0].filter == null);
});
