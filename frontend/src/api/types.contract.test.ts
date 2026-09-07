import { describe, expect, it } from "vitest";
import type { TopologyDoc, SubnetsDoc, PolicyDoc, LayoutDoc, DraftResponse, UserResponse } from "./types";
import * as fx from "./fixtures";

// Ключи фикстур — это и есть контракт: если Go добавит поле или переименует,
// здесь появится расхождение с типами (а не в рантайме на проде).
function expectKeys<T>(value: T, keys: string[]) {
  expect(Object.keys(value as object).sort()).toEqual([...keys].sort());
}

describe("API contract", () => {
  it("TopologyDoc matches Go json tags", () => {
    const t: TopologyDoc = fx.topologyFixture;
    expectKeys(t, ["devices", "links", "networks", "sets", "unions"]);
    expectKeys(t.devices[0], ["name", "kind"]);
    expectKeys(t.links[0], ["a", "b"]);
    expectKeys(t.networks[0], ["name", "subnets", "attach"]);
    expectKeys(t.sets[0], ["name", "addresses"]);
    expectKeys(t.unions[0], ["name", "devices"]);
  });

  it("SubnetsDoc matches Go json tags", () => {
    const s: SubnetsDoc = fx.subnetsFixture;
    expectKeys(s, ["subnets"]);
    expectKeys(s.subnets[0], ["name", "cidr"]);
  });

  it("PolicyDoc matches Go json tags", () => {
    const p: PolicyDoc = fx.policyFixture;
    expectKeys(p, ["chains"]);
    expectKeys(p.chains[0], ["name", "defaultAction", "chainPosition", "rules"]);
    expectKeys(p.chains[0].rules[0], ["name", "src", "dst", "proto", "dstPorts", "action"]);
  });

  it("LayoutDoc matches Go json tags", () => {
    const l: LayoutDoc = fx.layoutFixture;
    expectKeys(l, ["devices", "networks", "links", "camera"]);
    expectKeys(l.camera!, ["x", "y", "z"]);
  });

  it("DraftResponse and UserResponse match Go json tags", () => {
    const d: DraftResponse = fx.draftFixture;
    expectKeys(d, ["id", "owner", "name", "baseVersion", "status"]);
    const u: UserResponse = fx.userFixture;
    expectKeys(u, ["id", "username", "role", "activated", "createdAt"]);
  });
});
