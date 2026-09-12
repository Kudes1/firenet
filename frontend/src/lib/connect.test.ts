import { describe, expect, it } from "vitest";
import { canonicalLink } from "./links";
import { connectOutcome, type ConnectTarget } from "./connect";
import type { TopologyDoc } from "../api/types";

const device = (name: string): ConnectTarget => ({ kind: "device", name });
const network = (name: string): ConnectTarget => ({ kind: "network", name });

const doc: TopologyDoc = {
  devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch" }],
  links: [{ a: { device: "r1" }, b: { device: "sw1" } }],
  networks: [{ name: "office", attach: [{ device: "sw1" }] }],
  sets: [],
  unions: [],
};

describe("connectOutcome", () => {
  it("links two devices", () => {
    expect(connectOutcome(device("r1"), device("r2"), doc))
      .toEqual({ operation: { kind: "create-link", link: { a: { device: "r1" }, b: { device: "r2" } } } });
  });

  it("attaches a network to a device in either click order", () => {
    expect(connectOutcome(network("office"), device("r2"), doc))
      .toEqual({ operation: { kind: "attach-network", networkName: "office", attach: { device: "r2" } } });
    expect(connectOutcome(device("r2"), network("office"), doc))
      .toEqual({ operation: { kind: "attach-network", networkName: "office", attach: { device: "r2" } } });
  });

  // Имена в предупреждении — каноническая пара (легаси сортировал их же).
  it("refuses to link a network to a network", () => {
    const [a, b] = canonicalLink("office", "guest");
    expect(connectOutcome(network("office"), network("guest"), doc))
      .toEqual({ warning: `Сети ${a} и ${b} не могут быть соединены напрямую` });
  });

  it("cancels the pending pick when the same device is clicked twice", () => {
    expect(connectOutcome(device("r1"), device("r1"), doc)).toEqual({ cancel: true });
  });

  it("warns when the link already exists", () => {
    expect(connectOutcome(device("r1"), device("sw1"), doc))
      .toEqual({ warning: "Устройства r1 и sw1 уже соединены" });
    expect(connectOutcome(device("sw1"), device("r1"), doc))
      .toEqual({ warning: "Устройства r1 и sw1 уже соединены" });
  });

  it("warns when the network is already attached to the device", () => {
    expect(connectOutcome(network("office"), device("sw1"), doc))
      .toEqual({ warning: "Сеть office уже подключена к sw1" });
  });

  it("ignores the endpoint order of an existing link", () => {
    const mirrored: TopologyDoc = { ...doc, links: [{ a: { device: "sw1" }, b: { device: "r1" } }] };
    expect(connectOutcome(device("r1"), device("sw1"), mirrored)).toEqual({
      warning: "Устройства r1 и sw1 уже соединены",
    });
  });

  it("sorts the warning pair the same way as canonicalLink", () => {
    const [a, b] = canonicalLink("sw1", "r1");
    expect(connectOutcome(device("sw1"), device("r1"), doc)).toEqual({
      warning: `Устройства ${a} и ${b} уже соединены`,
    });
  });
});
