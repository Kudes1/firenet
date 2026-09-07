import type {
  TopologyDoc, SubnetsDoc, PolicyDoc, LayoutDoc, DraftResponse,
  UserResponse, SearchEntry, LintFinding, CompiledDevice, EditorSnapshot,
  VersionInfo, EntityDiff, DraftDiffEntry, Conflict, DiagnoseReport, MapMark,
  SpreadResult, DiagnoseRequest, SpreadRequest, LinkExportsResponse,
  LintResponse, ValidateResponse, CreateUserResponse, InviteInfoResponse,
  InviteURLResponse, RestoreResponse, ConfirmResponse, ErrorResponse,
  GraphNode, RouterVerdict, PathResult, DenyInfo, TopologyOperation,
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

// --- Ниже — фикстуры, добавленные в fix round 1: закрывают типами контракт-теста
// те wire-формы, у которых нет «главной» фикстуры (diff, diagnose, spread). ---

export const versionInfoFixture: VersionInfo = {
  id: 7,
  createdAt: "2026-09-01T10:00:00Z",
  confirmedBy: "admin",
  draftId: "d1",
  note: "правки по офису",
};

export const entityDiffFixture: EntityDiff = {
  kind: "device",
  key: "r1",
  change: "modified",
  before: { name: "r1", kind: "router" },
  after: { name: "r1", kind: "switch" },
};

export const draftDiffEntryFixture: DraftDiffEntry = {
  ...entityDiffFixture,
  conflict: true,
};

export const conflictFixture: Conflict = {
  kind: "device",
  key: "r1",
  draftValue: { name: "r1", kind: "switch" },
  currentValue: { name: "r1", kind: "router" },
};

export const mapMarkFixture: MapMark = {
  hl: ["office"],
  ok: ["r1"],
  okE: ["r1\u0000sw1"],
  denyE: [],
  half: [],
  halfE: [],
  deny: { r2: { rule: "block-dmz", reason: "нет подходящих правил" } },
};

export const graphNodeFixture: GraphNode = { kind: 0, name: "r1" };

export const routerVerdictFixture: RouterVerdict = {
  router: "r1",
  action: "allow",
  matchedRule: "web",
  reason: "сработало правило \"web\"",
  steps: ["цепочка FIRENET-FWD"],
};

export const pathResultFixture: PathResult = {
  nodes: [{ kind: 1, name: "lan" }, { kind: 0, name: "r1" }],
  routers: [routerVerdictFixture],
  verdict: "allow",
  note: "трафик не пересекает управляемые роутеры (L2-сегмент)",
};

export const denyInfoFixture: DenyInfo = { rule: "block-dmz", reason: "нет подходящих правил" };

export const diagnoseReportFixture: DiagnoseReport = {
  srcSubnet: "lan",
  dstSubnet: "dmz",
  note: "диагностика рассматривает первый пакет нового соединения",
  paths: [pathResultFixture],
  returnPathAllowed: false,
  mapMark: mapMarkFixture,
};

export const diagnoseRequestFixture: DiagnoseRequest = {
  src: "10.0.0.5",
  dst: "10.0.1.7",
  proto: "tcp",
  srcPorts: [],
  dstPorts: ["443"],
};

export const spreadRequestFixture: SpreadRequest = {
  src: "office",
  proto: "tcp",
  dstPorts: ["443"],
};

export const spreadResultFixture: SpreadResult = {
  sources: [{ IP: "10.0.0.0", SubnetName: "lan" }],
  reports: [{ candidate: "dmz", report: diagnoseReportFixture }],
  mark: mapMarkFixture,
};

// Ответы-обёртки: фиксируют ключ, в который Go кладёт payload.
export const linkExportsFixture: LinkExportsResponse = {
  entities: [{ name: "lan", cidr: "10.0.0.0/24" }],
};

export const lintResponseFixture: LintResponse = { findings: lintFixture };

// validate: пустой результат — это null, а не [] (handlers.go:542).
export const validateResponseFixture: ValidateResponse = { valid: true, errors: null };

export const restoreResponseFixture: RestoreResponse = { version: 12 };
export const confirmResponseFixture: ConfirmResponse = { version: 13 };
export const confirmConflictResponseFixture: ConfirmResponse = { conflicts: [conflictFixture] };
export const createUserResponseFixture: CreateUserResponse = {
  user: userFixture,
  inviteUrl: "http://localhost:8787/invite/tok",
};
export const inviteInfoResponseFixture: InviteInfoResponse = { username: "vera" };
export const inviteURLResponseFixture: InviteURLResponse = { inviteUrl: "http://localhost:8787/invite/tok" };
export const errorResponseFixture: ErrorResponse = { error: "draft not found" };

export const topologyOperationFixture: TopologyOperation = {
  kind: "set-device-position",
  deviceName: "r1",
  position: { x: 40, y: 40 },
};
