import { describe, expect, it } from "vitest";
import type { LayoutDoc, TopologyDoc } from "../api/types";
import { DEVICE_H, DEVICE_W, NET_H, NET_W } from "./icons";
import { buildScene, defaultPoint, unionColor } from "./scene";

const topology: TopologyDoc = {
  devices: [
    { name: "r1", kind: "router" },
    { name: "r2", kind: "router" },
    { name: "sw1", kind: "switch" },
  ],
  links: [
    { a: { device: "r1" }, b: { device: "r2" } },
    { a: { device: "r2" }, b: { device: "r1" } }, // резервная: тот же канонический ключ
    { a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: ["lan"], bExports: [] } },
  ],
  networks: [{ name: "office", subnets: ["lan"], attach: [{ device: "sw1" }] }],
  sets: [],
  unions: [{ name: "u1", devices: ["r1", "r2"] }],
};

const layout: LayoutDoc = {
  devices: { r1: { x: 0, y: 0 }, r2: { x: 300, y: 0 }, sw1: { x: 0, y: 200 } },
  networks: { office: { x: 0, y: 350 } },
  links: { "r1|sw1": [[{ x: 150, y: 120 }]] },
  camera: { x: 0, y: 0, z: 1 },
};

describe("buildScene", () => {
  it("makes one device node per positioned device", () => {
    const { nodes } = buildScene(topology, layout);
    const r1 = nodes.find((n) => n.id === "device:r1")!;
    expect(r1.position).toEqual({ x: 0, y: 0 });
    expect(r1.data.kind).toBe("router");
    expect(nodes.filter((n) => n.type === "device")).toHaveLength(3);
  });

  it("makes one network node per network", () => {
    const { nodes } = buildScene(topology, layout);
    const office = nodes.find((n) => n.id === "network:office")!;
    expect(office.position).toEqual({ x: 0, y: 350 });
    expect(office.data.kind).toBe("network");
  });

  // id рёбер-связей = `link:<key>#<offset>` (суффикс #<offset> — единственный
  // способ различить резервные связи с одним каноническим ключом). Поэтому
  // здесь и ниже сравниваем по префиксу, а не точным равенством.
  it("creates one edge per link with a stable id from the canonical pair", () => {
    const { edges } = buildScene(topology, layout);
    expect(edges.filter((e) => e.type === "link")).toHaveLength(3);
    expect(edges.filter((e) => e.id.startsWith("link:r1|r2"))).toHaveLength(2);
  });

  it("spreads redundant links so they render as distinct lines", () => {
    const { edges } = buildScene(topology, layout);
    const pair = edges.filter((e) => e.id.startsWith("link:r1|r2"));
    expect(pair[0].data.offset).not.toEqual(pair[1].data.offset);
  });

  it("marks a filtered link and carries its exports", () => {
    const { edges } = buildScene(topology, layout);
    const filtered = edges.find((e) => e.id.startsWith("link:r1|sw1"))!;
    expect(filtered.data.filtered).toBe(true);
    expect(filtered.data.filter!.aExports).toEqual(["lan"]);
  });

  it("carries waypoints from the layout for the matching duplicate", () => {
    const { edges } = buildScene(topology, layout);
    const filtered = edges.find((e) => e.id.startsWith("link:r1|sw1"))!;
    expect(filtered.data.waypoints).toEqual([{ x: 150, y: 120 }]);
  });

  it("creates an attach edge for every network attachment", () => {
    const { edges } = buildScene(topology, layout);
    const attach = edges.find((e) => e.type === "attach")!;
    expect(attach.id).toBe("attach:office|sw1");
    expect(attach.source).toBe("device:sw1");
    expect(attach.target).toBe("network:office");
  });

  it("skips links whose endpoints have no position yet", () => {
    const { edges } = buildScene(topology, { devices: { r1: { x: 0, y: 0 } } });
    expect(edges).toHaveLength(0);
    const { nodes } = buildScene(topology, { devices: { r1: { x: 0, y: 0 } } });
    expect(nodes.find((n) => n.id === "device:r2")).toBeUndefined();
  });

  it("returns the saved camera as the viewport when it is sane", () => {
    const { viewport } = buildScene(topology, layout);
    expect(viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("ignores a degenerate camera", () => {
    const { viewport } = buildScene(topology, { ...layout, camera: { x: 0, y: 0, z: 0 } });
    expect(viewport).toBeUndefined();
  });
});

describe("defaultPoint", () => {
  it("lays devices and networks out on separate grids", () => {
    expect(defaultPoint("device", 0)).toEqual({ x: 40, y: 40 });
    expect(defaultPoint("device", 5)).toEqual({ x: 40, y: 200 });
    expect(defaultPoint("network", 0)).toEqual({ x: 40, y: 300 });
  });
});

describe("unionColor", () => {
  it("is stable per union index and wraps around", () => {
    expect(unionColor(0)).toBe(unionColor(0));
    expect(unionColor(8)).toBe(unionColor(0));
  });
});

describe("node sizes", () => {
  it("matches the legacy canvas geometry", () => {
    expect([DEVICE_W, DEVICE_H, NET_W, NET_H]).toEqual([140, 60, 160, 60]);
  });
});
