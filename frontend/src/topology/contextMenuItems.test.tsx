import { describe, expect, it } from "vitest";
import { topologyFixture } from "../api/fixtures";
import { contextMenuItems } from "./contextMenuItems";
import type { TopologyDoc } from "../api/types";

const doc: TopologyDoc = topologyFixture;

describe("contextMenuItems", () => {
  it("offers edit, union submenu and delete for a device", () => {
    const items = contextMenuItems({
      doc, target: { kind: "node", id: "device:sw1" }, editable: true,
      actions: {} as never,
    });
    expect(items.map((i) => i.label)).toEqual(["Редактировать", "Добавить в объединение", "Удалить устройство sw1"]);
    // r1 сидит в u1, sw1 — ни в одном: подменю предлагает u1.
    const sub = items[1].children!;
    expect(sub.map((i) => i.label)).toEqual(["В объединение «u1»"]);
  });

  it("offers edit, union submenu and delete for a network", () => {
    const items = contextMenuItems({
      doc, target: { kind: "node", id: "network:office" }, editable: true,
      actions: {} as never,
    });
    expect(items.map((i) => i.label)).toEqual(["Редактировать", "Добавить в объединение", "Удалить сеть office"]);
  });

  it("offers removing from union when the node belongs to one", () => {
    const items = contextMenuItems({
      doc, target: { kind: "node", id: "device:r1" }, editable: true,
      actions: {} as never,
    });
    expect(items.map((i) => i.label)).toEqual(["Редактировать", "Убрать из объединения", "Добавить в объединение", "Удалить устройство r1"]);
    // u1 — единственное объединение и r1 уже в нём: подменю пустое.
    expect(items[2].children).toHaveLength(0);
  });

  it("offers filter editing for a plain link and delete for links/attachments", () => {
    const link = contextMenuItems({
      doc, target: { kind: "link", id: "link:r1|sw1#0", a: "r1", b: "sw1", filtered: false }, editable: true,
      actions: {} as never,
    });
    expect(link.map((i) => i.label)).toEqual(["Фильтровать", "Удалить связь r1–sw1"]);

    const attach = contextMenuItems({
      doc, target: { kind: "attach", id: "attach:office|sw1", network: "office", device: "sw1" }, editable: true,
      actions: {} as never,
    });
    expect(attach.map((i) => i.label)).toEqual(["Удалить привязку office–sw1"]);
  });

  it("offers filter editing for a filtered link", () => {
    const docFiltered: TopologyDoc = {
      ...doc,
      links: [{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: [], bExports: [] } }],
    };
    const items = contextMenuItems({
      doc: docFiltered, target: { kind: "link", id: "link:r1|sw1#0", a: "r1", b: "sw1", filtered: true }, editable: true,
      actions: {} as never,
    });
    expect(items.map((i) => i.label)).toEqual(["Редактировать фильтр", "Удалить связь r1–sw1"]);
  });

  it("disables everything in read-only mode", () => {
    const items = contextMenuItems({
      doc, target: { kind: "node", id: "device:r1" }, editable: false,
      actions: {} as never,
    });
    for (const item of items) expect(item.action).toBeUndefined();
  });

  it("applies union changes to every selected node, not only the clicked one", () => {
    const added: Array<{ name: string; kind: "device" | "network"; union: string | null }> = [];
    const items = contextMenuItems({
      doc,
      target: { kind: "node", id: "device:sw1" },
      editable: true,
      selection: ["device:r1", "device:sw1"],
      actions: {
        setUnion: (name: string, kind: "device" | "network", union: string | null) => added.push({ name, kind, union }),
      } as never,
    });
    // sw1 под курсором, r1 в выделении; добавляется только sw1 — r1 уже
    // сидит в u1, и легаси дублирующую union-add не слал.
    const add = items.find((i) => i.label === "Добавить в объединение")!;
    add.children![0].action!();
    expect(added).toEqual([
      { name: "sw1", kind: "device", union: "u1" },
    ]);
  });

  // Членство проверяется по полю ТИПА каждого узла: в смешанном выделении
  // (устройство + сеть) офис уже сидит в u1.networks — объединение не
  // предлагается, хотя в u1.devices его нет.
  it("does not offer a union when every selected node is already in it (mixed kinds)", () => {
    const docMixed: TopologyDoc = {
      ...doc,
      unions: [{ name: "u1", devices: ["r1"], networks: ["office"] }],
    };
    const added: Array<{ name: string; kind: "device" | "network"; union: string | null }> = [];
    const items = contextMenuItems({
      doc: docMixed,
      target: { kind: "node", id: "device:r1" },
      editable: true,
      selection: ["device:r1", "network:office"],
      actions: {
        setUnion: (name: string, kind: "device" | "network", union: string | null) => added.push({ name, kind, union }),
      } as never,
    });
    expect(items.find((i) => i.label === "Добавить в объединение")!.children).toHaveLength(0);
  });

  it("deletes only the object under the cursor, by identity", () => {
    const removed: string[] = [];
    const items = contextMenuItems({
      doc, target: { kind: "node", id: "device:r1" }, editable: true,
      selection: ["device:r1", "device:sw1"],
      actions: { deleteNode: (id: string) => removed.push(id) } as never,
    });
    items[items.length - 1].action!();
    // Паритет с легаси: удаляется один объект под курсором, не выделение.
    expect(removed).toEqual(["device:r1"]);
  });
});
