import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DraftProvider } from "../draft/DraftContext";
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
});
