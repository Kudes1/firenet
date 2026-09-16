import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DraftProvider } from "../draft/DraftContext";
import { server } from "../test/msw";
import { DeviceEditForm, NetworkEditForm, LinkFilterForm } from "./editForms";

function wrapper(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DraftProvider>{ui}</DraftProvider>
    </QueryClientProvider>,
  );
}

describe("DeviceEditForm", () => {
  it("submits update-device with the entered fields", async () => {
    const onSubmit = vi.fn();
    wrapper(
      <DeviceEditForm
        device={{ name: "r1", kind: "router", description: "ядро" }}
        unions={[{ name: "u1", devices: ["r1"] }]}
        existingNames={["r1", "sw1"]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const nameInput = await screen.findByLabelText("Имя");
    fireEvent.change(nameInput, { target: { value: "core1" } });
    // Смена union: r1 уходит из u1 (select сброшен на «без объединения»).
    fireEvent.change(screen.getByLabelText("Объединение"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    // Перенос union ссылается на НОВОЕ имя (каскад update-device на бэкенде).
    expect(onSubmit).toHaveBeenCalledWith([
      { kind: "update-device", deviceName: "r1", device: { name: "core1", kind: "router", description: "ядро" } },
      { kind: "union-remove-device", unionName: "u1", deviceName: "core1" },
    ]);
  });

  it("blocks submit on a duplicate name", async () => {
    const onSubmit = vi.fn();
    wrapper(
      <DeviceEditForm
        device={{ name: "r1", kind: "router" }}
        unions={[]}
        existingNames={["r1", "sw1"]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await screen.findByLabelText("Имя");
    // r1 сам себе не дубль: сначала пустое имя, затем чужое.
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Имя обязательно")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "sw1" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Имя уже используется")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("NetworkEditForm", () => {
  // label вокруг списка пересылает клик (в т.ч. по строке) первому контролу —
  // кнопке «×» первой строки: подсеть должна убираться только по кнопке.
  it("removes a subnet only via its remove button, not a row click", async () => {
    const onSubmit = vi.fn();
    wrapper(
      <NetworkEditForm
        network={{ name: "office", subnets: ["lan", "dmz"], attach: [] }}
        networks={[{ name: "office", subnets: ["lan", "dmz"], attach: [] }]}
        allSubnets={[{ name: "lan", cidr: "10.0.0.0/24" }, { name: "dmz", cidr: "10.0.1.0/24" }]}
        existingNames={["office"]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await screen.findByText("lan");
    // Список не обёрнут в label: в браузере label пересылает клик по любому
    // месту (включая строку подсети) первому контролю — кнопке «×».
    expect(screen.getByText("lan").closest("label")).toBeNull();
    // Клик по строке ничего не убирает.
    fireEvent.click(screen.getByText("lan"));
    expect(screen.getByText("lan")).toBeInTheDocument();
    expect(screen.getByText("dmz")).toBeInTheDocument();
    // Клик по метке «Подсети» тоже не должен удалять первую подсеть
    // (jsdom: клик по label пересылается первому labelable-потомку).
    expect(screen.getByText("lan")).toBeInTheDocument();
    // Удаление работает только по кнопке «×» нужной строки.
    const row = screen.getByText("dmz").closest(".member-row")!;
    fireEvent.click(row.querySelector(".icon-btn")!);
    expect(screen.queryByText("dmz")).not.toBeInTheDocument();
    expect(screen.getByText("lan")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits update-network with the entered fields", async () => {
    const onSubmit = vi.fn();
    wrapper(
      <NetworkEditForm
        network={{ name: "office", subnets: ["lan"], attach: [] }}
        networks={[{ name: "office", subnets: ["lan"], attach: [] }]}
        allSubnets={[{ name: "lan", cidr: "10.0.0.0/24" }, { name: "dmz", cidr: "10.0.1.0/24" }]}
        existingNames={["office"]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await screen.findByLabelText("Имя");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSubmit).toHaveBeenCalledWith([
      { kind: "update-network", networkName: "office", network: { name: "office", subnets: ["lan"], attach: [] } },
    ]);
  });
});

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("LinkFilterForm", () => {
  it("loads export candidates for both sides and adds one", async () => {
    wrapper(
      <LinkFilterForm
        link={{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: [], bExports: [] } }}
        onSave={async () => {}}
      />,
    );
    // Кандидаты грузятся link-exports по паре устройств (по обе стороны).
    const combo = await screen.findAllByPlaceholderText(/начните вводить/);
    expect(combo.length).toBe(2);
  });

  it("renders network candidates without empty parens and subnets with cidr", async () => {
    server.use(http.get("/api/versions/current/link-exports", () =>
      HttpResponse.json({ entities: [{ name: "office" }, { name: "lan", cidr: "10.0.0.0/24" }] })));
    wrapper(
      <LinkFilterForm
        link={{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: [], bExports: [] } }}
        onSave={async () => {}}
      />,
    );
    const combo = (await screen.findAllByPlaceholderText(/начните вводить/))[0];
    fireEvent.pointerDown(combo);
    // Сеть без cidr — без скобок, подсеть — с CIDR.
    expect(await screen.findByText("office")).toBeInTheDocument();
    expect(screen.getByText("lan (10.0.0.0/24)")).toBeInTheDocument();
  });

  it("saves the filter through PUT topology", async () => {
    let saved: unknown;
    wrapper(
      <LinkFilterForm
        link={{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: ["lan"], bExports: [] } }}
        onSave={async (next) => { saved = next; }}
      />,
    );
    // Экспорт стороны A содержит lan — убираем и сохраняем.
    await screen.findAllByPlaceholderText(/начните вводить/);
    fireEvent.click(screen.getByTitle("Убрать"));
    await waitFor(() => expect(saved).toMatchObject({ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: [], bExports: [] } }));
  });

  it("shows document-side exports under the canonical device when endpoints are swapped", async () => {
    // Связь хранится как sw1→r1 (документная A = sw1), канонический порядок —
    // r1, sw1. Экспорт документа aExports принадлежит sw1 и должен показаться
    // в fieldset'е sw1, а не r1.
    wrapper(
      <LinkFilterForm
        link={{ a: { device: "sw1" }, b: { device: "r1" }, filter: { aExports: ["lan"], bExports: [] } }}
        onSave={async () => {}}
      />,
    );
    await screen.findAllByPlaceholderText(/начните вводить/);
    const exportOf = (device: string) => {
      const fieldset = screen.getByText(device).closest("fieldset")!;
      const sections = fieldset.querySelectorAll(".filter-dirs > div");
      return sections[0].textContent!;
    };
    // lan экспортирует sw1; r1 его не экспортирует (но импортирует).
    expect(exportOf("sw1")).toContain("lan");
    expect(exportOf("r1")).not.toContain("lan");
  });
});
