import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useDraft } from "../draft/DraftContext";
import { api } from "./client";
import type {
  CompiledDevice, DiagnoseReport, DiagnoseRequest, DraftDiffEntry, DraftResponse,
  EditorSnapshot, LintResponse, SearchEntry, SpreadRequest,
  SpreadResult, TopologyOperation, UserResponse,
  ValidateResponse, VersionInfo,
} from "./types";

// Ресурсы проекта, которые бывают и в драфте, и в текущей версии.
export type ProjectResource =
  | "topology" | "subnets" | "rules" | "layout" | "search-index" | "lint";

export const projectKeys = {
  all: ["project"] as const,
  scope: (scope: string) => ["project", scope] as const,
  resource: (scope: string, resource: ProjectResource) => ["project", scope, resource] as const,
  derived: (scope: string, name: string, args?: unknown) =>
    ["project", scope, "derived", name, args] as const,
};

export const queryKeys = {
  drafts: (all: boolean) => ["drafts", all] as const,
  versions: (limit: number) => ["versions", limit] as const,
  versionDiff: (from: number, to: number) => ["versions", "diff", from, to] as const,
  users: ["users"] as const,
  me: ["me"] as const,
};

export function useProjectResource<T>(resource: ProjectResource) {
  const { scope, apiPath } = useDraft();
  return useQuery({
    queryKey: projectKeys.resource(scope, resource),
    queryFn: () => api.get<T>(apiPath(resource)),
  });
}

type SaveOptions = {
  // Производные ресурсы, которые надо пересчитать после записи:
  // правка rules делает невалидными lint и search-index.
  invalidate?: ProjectResource[];
};

export function useProjectSave<T>(resource: ProjectResource, options: SaveOptions = {}) {
  const { scope, apiPath } = useDraft();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (doc: T) => api.put<T>(apiPath(resource), doc),
    onSuccess: (data) => {
      qc.setQueryData(projectKeys.resource(scope, resource), data);
      for (const derived of options.invalidate ?? []) {
        void qc.invalidateQueries({ queryKey: projectKeys.resource(scope, derived) });
      }
    },
  });
}

// Операции топологии возвращают EditorSnapshot — новый документ и layout
// сразу, без второго чтения. Одна операция уходит сама, несколько — батчем
// (бэкенд валидирует итог один раз).
export function useTopologyOperations() {
  const { scope, apiPath } = useDraft();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ops: TopologyOperation[]) =>
      ops.length === 1
        ? api.post<EditorSnapshot>(apiPath("topology/operations"), ops[0])
        : api.post<EditorSnapshot>(apiPath("topology/operations/batch"), { operations: ops }),
    onSuccess: (snapshot) => {
      qc.setQueryData(projectKeys.resource(scope, "topology"), snapshot.topology);
      qc.setQueryData(projectKeys.resource(scope, "layout"), snapshot.layout);
    },
  });
}

export function useLint() {
  const { scope, apiPath } = useDraft();
  return useQuery({
    queryKey: projectKeys.resource(scope, "lint"),
    queryFn: () => api.get<LintResponse>(apiPath("lint")),
  });
}

export type { UseQueryResult };

export function useCompile() {
  const { scope, apiPath } = useDraft();
  return useMutation({
    mutationFn: () => api.post<CompiledDevice[]>(apiPath("compile"), {}),
    mutationKey: projectKeys.derived(scope, "compile"),
  });
}

export function useValidate() {
  const { apiPath } = useDraft();
  return useMutation({
    mutationFn: () => api.post<ValidateResponse>(apiPath("validate"), {}),
  });
}

export function useDiagnose() {
  const { apiPath } = useDraft();
  return useMutation({
    mutationFn: (req: DiagnoseRequest) => api.post<DiagnoseReport>(apiPath("diagnose"), req),
  });
}

export function useSpread() {
  const { apiPath } = useDraft();
  return useMutation({
    mutationFn: (req: SpreadRequest) => api.post<SpreadResult>(apiPath("diagnose/spread"), req),
  });
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => api.get<UserResponse>("/api/me") });
}

export function useDrafts(all: boolean) {
  return useQuery({
    queryKey: queryKeys.drafts(all),
    queryFn: () => api.get<DraftResponse[]>(all ? "/api/drafts?all=1" : "/api/drafts"),
  });
}

export function useCreateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<DraftResponse>("/api/drafts", { name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["drafts"] }),
  });
}

export function useDraftDiff(id: string | null) {
  return useQuery({
    queryKey: ["drafts", id, "diff"],
    queryFn: () => api.get<DraftDiffEntry[]>(`/api/drafts/${id}/diff`),
    enabled: !!id,
  });
}

export function useConfirmDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ version: number }>(`/api/drafts/${id}/confirm`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["drafts"] });
      void qc.invalidateQueries({ queryKey: ["versions"] });
    },
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/api/drafts/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["drafts"] }),
  });
}

export function useVersions(limit = 50) {
  return useQuery({
    queryKey: queryKeys.versions(limit),
    queryFn: () => api.get<VersionInfo[]>(`/api/versions?limit=${limit}`),
  });
}

export function useVersionDiff(from: number | null, to: number | null) {
  return useQuery({
    queryKey: queryKeys.versionDiff(from ?? 0, to ?? 0),
    queryFn: () => api.get<unknown[]>(`/api/versions/diff?from=${from}&to=${to}`),
    enabled: from !== null && to !== null,
  });
}

export function useRestoreVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (n: number) => api.post<{ version: number }>(`/api/versions/${n}/restore`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["versions"] }),
  });
}

export function useUsers() {
  return useQuery({ queryKey: queryKeys.users, queryFn: () => api.get<UserResponse[]>("/api/users") });
}

export function useSearchIndex() {
  const { scope, apiPath } = useDraft();
  return useQuery({
    queryKey: projectKeys.resource(scope, "search-index"),
    queryFn: () => api.get<SearchEntry[]>(apiPath("search-index")),
  });
}
