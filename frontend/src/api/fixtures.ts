import type {
  TopologyDoc, SubnetsDoc, PolicyDoc, LayoutDoc, DraftResponse,
  UserResponse, SearchEntry, LintFinding, CompiledDevice, EditorSnapshot,
} from "./types";

export const topologyFixture: TopologyDoc = {
  devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch", description: "подъезд" }],
  links: [{ a: { device: "r1" }, b: { device: "sw1" } }],
  networks: [{ name: "office", subnets: ["lan"], attach: [{ device: "sw1" }] }],
  sets: [{ name: "srv", addresses: ["10.0.0.5/32"] }],
  unions: [{ name: "u1", devices: ["r1"] }],
};

export const subnetsFixture: SubnetsDoc = {
  subnets: [{ name: "lan", cidr: "10.0.0.0/24" }],
};

export const policyFixture: PolicyDoc = {
  chains: [{
    name: "FORWARD",
    defaultAction: "deny",
    chainPosition: "top",
    rules: [{ name: "web", src: ["lan"], dst: ["any"], proto: "tcp", dstPorts: ["80"], action: "allow" }],
  }],
};

export const layoutFixture: LayoutDoc = {
  devices: { r1: { x: 40, y: 40 } },
  networks: {},
  links: {},
  camera: { x: 0, y: 0, z: 1 },
};

export const editorSnapshotFixture: EditorSnapshot = {
  topology: topologyFixture,
  layout: layoutFixture,
};

export const draftFixture: DraftResponse = {
  id: "d1", owner: "u1", name: "правки", baseVersion: 3, status: "open",
};

export const userFixture: UserResponse = {
  id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
};

export const searchIndexFixture: SearchEntry[] = [
  { type: "device", name: "r1", details: "router" },
  { type: "subnet", name: "lan", details: "10.0.0.0/24", prefixes: ["10.0.0.0/24"] },
];

export const lintFixture: LintFinding[] = [
  { severity: "warning", chain: "FORWARD", rules: ["web"], message: "правило недостижимо" },
];

export const compileFixture: CompiledDevice[] = [
  { Name: "r1", IPSetsScript: "create lan hash:net", RulesScript: "-A FORWARD -j ACCEPT" },
];
