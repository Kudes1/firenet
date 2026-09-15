// Wire-формат firenet API. Имена полей — точные копии JSON-тегов Go:
// internal/projectdoc/{topology,subnets,rules,layout,project}.go и
// DTO из internal/httpapi/{dto,handlers,draft_handlers,version_handlers,
// user_handlers,search_index}.go.
// types.contract.test.ts ловит опечатки в именах полей и расхождение
// фикстур с TS-типами; дрейф этих типов относительно Go он не ловит —
// см. комментарий в шапке теста.
//
// Отклонения от брифа (Go — источник истины). Правило для nullable-слайсов:
// Go кодирует nil-слайс в null, а пустой — в []. Поэтому слайс nullable там,
// где Go собирает его как `var x []T` + append, и не nullable там, где
// гарантирован make/литерал. Правило проверено запуском encoding/json.
// Nullable (var + append):
//  - ValidateResponse.errors — handlers.go/validateDoc, на валидном проекте
//    {"valid":true,"errors":null};
//  - LintResponse.findings — lint.go:40, на чистом линте {"findings":null};
//  - TopologyDoc.* / SubnetsDoc.subnets / PolicyDoc.chains —
//    pgstore/entities.go:238-292, пустой проект даёт null.
// Не nullable (Go гарантирует конструктор):
//  - ChainDoc.rules — entities.go:287 make(..., len): на чтении цепочка
//    всегда реконструируется из БД; см. комментарий к типу про PUT;
//  - DiagnoseReport.paths — diagnose.go:105 литерал []PathResult{};
//  - MapMark.* — mapmark.go:38-45 инициализирует все семь полей;
//  - LinkExportsResponse.entities — handlers.go/writeLinkExports make(..., 0, len).
// Плюс указатели: DiagnoseReport.mapMark, SpreadResult.mark (*MapMark) и
// SpreadResult.reports[].report (*Report) — nullable, приходят как null.

export type ErrorResponse = { error: string };

export type EndpointDoc = { device: string };
export type LinkFilterDoc = { aExports: string[]; bExports: string[] };
export type LinkDoc = { a: EndpointDoc; b: EndpointDoc; filter?: LinkFilterDoc };

export type DeviceKind = "router" | "switch";
export type DeviceDoc = { name: string; kind: DeviceKind; description?: string };

export type NetworkDoc = {
  name: string;
  subnets?: string[];
  attach?: EndpointDoc[];
  description?: string;
};

export type SetDoc = {
  name: string;
  subnets?: string[];
  addresses?: string[];
  description?: string;
};

export type UnionDoc = {
  name: string;
  devices?: string[];
  networks?: string[];
  description?: string;
};

// Пять слайсов ниже — nil на пустом проекте (pgstore.fromEntities собирает их
// через append к нулевому значению, entities.go:238-271), приходит null.
export type TopologyDoc = {
  devices: DeviceDoc[] | null;
  links: LinkDoc[] | null;
  networks: NetworkDoc[] | null;
  sets: SetDoc[] | null;
  unions: UnionDoc[] | null;
};

export type SubnetDoc = { name: string; cidr: string; description?: string };
export type SubnetsDoc = { subnets: SubnetDoc[] | null };

export type RuleAction = "allow" | "deny" | "return" | "jump";
export type RuleDoc = {
  name: string;
  comment?: string;
  src: string[];
  dst: string[];
  proto?: string;
  srcPorts?: string[];
  dstPorts?: string[];
  action: RuleAction;
  jumpTo?: string;
  mirror?: boolean;
};

// chainPosition в Go — просто string (валидируется как "top"/"bottom" только
// на первой цепочке), поэтому тип оставляем строковым union по фактическим
// значениям rules.ChainTop/ChainBottom.
export type ChainPosition = "top" | "bottom";
export type ChainDoc = {
  name: string;
  defaultAction: string;
  chainPosition?: ChainPosition;
  rules: RuleDoc[];
};

// chains — nil, если ни одной цепочки нет в версии (append в
// pgstore.fromEntities). На практике Seed всегда пишет первичную цепочку, а
// rules.Validate требует хотя бы одну, но тип описывает wire, а не инвариант.
export type PolicyDoc = { chains: ChainDoc[] | null };

export type LayoutPoint = { x: number; y: number };
export type LayoutCamera = { x: number; y: number; z: number };
export type LayoutDoc = {
  devices?: Record<string, LayoutPoint>;
  networks?: Record<string, LayoutPoint>;
  links?: Record<string, LayoutPoint[][]>;
  camera?: LayoutCamera;
};

export type EntityDoc = { name: string; cidr?: string };

// kind — полный список из internal/httpapi/topology_operations.go.
// Поля, которые читает каждый kind, см. в комментариях там же.
export type TopologyOperationKind =
  | "create-device" | "update-device" | "delete-device"
  | "create-network" | "update-network" | "delete-network"
  | "create-link" | "delete-link" | "set-link-filter" | "clear-link-filter"
  | "create-union" | "delete-union"
  | "attach-network" | "detach-network"
  | "union-add-device" | "union-remove-device"
  | "union-add-network" | "union-remove-network"
  | "set-device-position" | "set-network-position"
  | "set-link-waypoints" | "set-camera";

export type TopologyOperation = {
  kind: TopologyOperationKind | string;
  device?: DeviceDoc;
  network?: NetworkDoc;
  link?: LinkDoc;
  union?: UnionDoc;
  filter?: LinkFilterDoc;
  deviceName?: string;
  networkName?: string;
  unionName?: string;
  attach?: EndpointDoc;
  position?: LayoutPoint;
  waypoints?: LayoutPoint[][];
  camera?: LayoutCamera;
};

export type EditorSnapshot = { topology: TopologyDoc; layout: LayoutDoc };

export type DraftStatus = "open" | "conflict" | "merged" | "closed";
export type DraftResponse = {
  id: string;
  owner: string;
  name: string;
  baseVersion: number;
  status: DraftStatus;
};

export type VersionInfo = {
  id: number;
  createdAt: string;
  confirmedBy?: string;
  draftId?: string;
  note?: string;
};

export type UserRole = "admin" | "user";
export type UserResponse = {
  id: string;
  username: string;
  role: UserRole;
  activated: boolean;
  createdAt: string;
};

export type SearchEntryType =
  | "device" | "subnet" | "network" | "set" | "union" | "link" | "rule";
export type SearchEntry = {
  type: SearchEntryType;
  name: string;
  details?: string;
  description?: string;
  prefixes?: string[];
};

export type LintFinding = {
  severity: "warning" | "info";
  chain: string;
  rules?: string[];
  message: string;
};

// У compiled-устройств в Go нет json-тегов — приходят имена полей Go.
export type CompiledDevice = {
  Name: string;
  IPSetsScript: string;
  RulesScript: string;
};

export type EntityDiff = {
  kind: string;
  key: string;
  change: "added" | "modified" | "removed";
  before?: unknown;
  after?: unknown;
};

export type DraftDiffEntry = EntityDiff & { conflict: boolean };
export type Conflict = {
  kind: string;
  key: string;
  draftValue?: unknown;
  currentValue?: unknown;
};

export type GraphNodeKind = 0 | 1 | 2; // 0 router, 1 subnet, 2 L2 domain
export type GraphNode = { kind: GraphNodeKind; name: string };
export type RouterVerdict = {
  router: string;
  action: "allow" | "deny" | "return" | "jump";
  matchedRule?: string;
  reason: string;
  steps?: string[];
};
export type PathResult = {
  nodes: GraphNode[];
  routers: RouterVerdict[];
  verdict: "allow" | "deny" | "return";
  note?: string;
};
export type DenyInfo = { rule: string; reason: string };
export type MapMark = {
  hl: string[];
  ok: string[];
  okE: string[];
  denyE: string[];
  half: string[];
  halfE: string[];
  deny: Record<string, DenyInfo>;
};
// mapMark — *MapMark в Go: null, если карту не удалось построить.
export type DiagnoseReport = {
  srcSubnet: string;
  dstSubnet: string;
  note: string;
  paths: PathResult[];
  returnPathAllowed: boolean;
  mapMark: MapMark | null;
};

export type DiagnoseRequest = {
  src: string;
  dst: string;
  proto: "" | "tcp" | "udp" | "icmp";
  srcPorts: string[];
  dstPorts: string[];
};

export type SpreadRequest = {
  src: string;
  proto: "" | "tcp" | "udp" | "icmp";
  dstPorts: string[];
};

// diagnose.Source тоже без json-тегов — приходят имена полей Go.
export type SpreadResult = {
  sources: Array<{ IP: string; SubnetName: string }>;
  reports: Array<{ candidate: string; report: DiagnoseReport | null }>;
  mark: MapMark | null;
};

export type LinkExportsResponse = { entities: EntityDoc[] };
// errors/findings — nil-слайсы при пустом результате: {"errors":null} при
// валидном проекте (handlers.go/validateDoc) и {"findings":null} при чистом
// линте (lint.go:40). Ловить .length без проверки на null нельзя.
export type LintResponse = { findings: LintFinding[] | null };
export type ValidateResponse = { valid: boolean; errors: string[] | null };
export type RestoreResponse = { version: number };
export type ConfirmResponse = { version: number } | { conflicts: Conflict[] };
export type CreateUserResponse = { user: UserResponse; inviteUrl: string };
export type InviteURLResponse = { inviteUrl: string };
export type InviteInfoResponse = { username: string };
