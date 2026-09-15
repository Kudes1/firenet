import { useState } from "react";
import {
  useConfirmDraft, useCreateDraft, useDeleteDraft, useDraftDiff, useDrafts, useMe,
} from "../api/queries";
import type { DraftDiffEntry, DraftResponse } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold } from "../lib/search";
import { notify } from "../components/notify";
import DataTable, { type Column } from "../components/ui/DataTable";
import { DeleteIcon } from "../components/icons";

const CHANGE_LABEL: Record<string, string> = { added: "добавлено", modified: "изменено", removed: "удалено" };
const DRAFT_STATUS_CLASS: Record<string, string> = {
  open: "draft-status-open",
  conflict: "draft-status-conflict",
  merged: "draft-status-merged",
  closed: "draft-status-closed",
};

export default function DraftsPage() {
  const me = useMe();
  const { draftId, setDraftId } = useDraft();
  const [all, setAll] = useState(false);
  const [diffFor, setDiffFor] = useState<string | null>(null);

  const drafts = useDrafts(all && me.data?.role === "admin");
  const create = useCreateDraft();
  const remove = useDeleteDraft();
  const confirm = useConfirmDraft();
  const diff = useDraftDiff(diffFor);

  const onCreate = async (name: string) => {
    if (!name.trim()) return;
    try {
      const draft = await create.mutateAsync(name.trim());
      notify(`Черновик «${draft.name}» создан`, "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const onDelete = async (draft: DraftResponse) => {
    if (!window.confirm(`Удалить черновик ${draft.name}?`)) return;
    try {
      await remove.mutateAsync(draft.id);
      if (draftId === draft.id) setDraftId(null);
      setDiffFor((current) => (current === draft.id ? null : current));
      notify("Черновик удалён", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const onConfirm = async (draft: DraftResponse) => {
    try {
      const result = await confirm.mutateAsync(draft.id);
      notify(`Черновик подтверждён как версия ${result.version}`, "ok");
      if (draftId === draft.id) setDraftId(null);
    } catch (error) {
      // 409 приходит и как текст, и как список конфликтов — в обоих случаях
      // это не ошибка приложения, а состояние, которое надо показать.
      const conflicts = (error as { data?: { conflicts?: unknown[] } }).data?.conflicts;
      notify(conflicts ? "Есть конфликты с текущей версией" : (error as Error).message);
      if (conflicts) setDiffFor(draft.id);
    }
  };

  const rows = drafts.data ?? [];
  const columns: Column<DraftResponse>[] = [
    {
      key: "name",
      title: "Название",
      width: "25%",
      minWidth: 180,
      render: (draft) => <span className="draft-name">{draft.name}</span>,
      filter: (draft, query) => containsFold(draft.name, query),
    },
    {
      key: "owner",
      title: "Автор",
      width: "18%",
      minWidth: 130,
      render: (draft) => draft.owner,
      filter: (draft, query) => containsFold(draft.owner, query),
    },
    {
      key: "baseVersion",
      title: "База",
      width: "12%",
      minWidth: 90,
      render: (draft) => draft.baseVersion,
      filter: (draft, query) => String(draft.baseVersion).includes(query.trim()),
    },
    {
      key: "status",
      title: "Статус",
      width: "16%",
      minWidth: 130,
      render: (draft) => (
        <span className={`draft-status ${DRAFT_STATUS_CLASS[draft.status] ?? "draft-status-other"}`}>
          {draft.status}
        </span>
      ),
      filter: (draft, query) => containsFold(draft.status, query),
    },
    {
      key: "actions",
      title: "",
      width: "29%",
      minWidth: 300,
      filterReset: true,
      render: (draft) => (
        <div className="draft-actions">
          <button type="button" title={`Открыть черновик ${draft.name}`} onClick={() => setDraftId(draft.id)}>Открыть</button>
          <button type="button" className="secondary" title={`Изменения черновика ${draft.name}`} onClick={() => setDiffFor(diffFor === draft.id ? null : draft.id)}>Изменения</button>
          {me.data?.role === "admin" && draft.status !== "merged" && (
            <button type="button" className="primary" title={`Подтвердить черновик ${draft.name}`} onClick={() => onConfirm(draft)}>Подтвердить</button>
          )}
          <button type="button" className="icon-btn delete" title={`Удалить черновик ${draft.name}`} aria-label={`Удалить черновик ${draft.name}`} onClick={() => onDelete(draft)}><DeleteIcon /></button>
        </div>
      ),
    },
  ];

  return (
    <main className="page drafts-page" data-testid="page-drafts">
      <DataTable
        id="drafts-table"
        columns={columns}
        rows={rows}
        rowKey={(draft) => draft.id}
        empty="Черновиков нет — создайте первый"
        resizable
        storageKey="firenet:drafts:column-widths"
        hint={(
          <div className="drafts-heading">
            <h1>Черновики</h1>
            <p className="hint">Личные черновики и их подтверждение.</p>
          </div>
        )}
        actions={(
          <>
            {me.data?.role === "admin" && (
              <label className="modal-check">
                <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
                Показывать все
              </label>
            )}
            <form
              id="create-draft-form"
              className="draft-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement;
                void onCreate(input.value);
                input.value = "";
              }}
            >
              <label>
                <span>Название</span>
                <input name="name" required placeholder="правки для офиса" />
              </label>
              <button type="submit" className="primary">Создать</button>
            </form>
          </>
        )}
      />

      {diffFor && (
        <div className="page-panel draft-diff-panel" id="diff-panel" data-testid="diff-panel">
          <div className="lint-panel-header">
            <strong>{`Изменения: ${rows.find((d) => d.id === diffFor)?.name ?? diffFor}`}</strong>
            <button type="button" className="lint-panel-close" onClick={() => setDiffFor(null)}>×</button>
          </div>
          <table className="data-table" id="diff-body">
            <thead><tr><th>Тип</th><th>Ключ</th><th>Изменение</th></tr></thead>
            <tbody>
              {(diff.data ?? []).map((item: DraftDiffEntry, i) => (
                <tr key={i} className={item.conflict ? "conflict-row" : undefined}>
                  <td>{item.kind}</td>
                  <td>{item.key}</td>
                  <td>{`${CHANGE_LABEL[item.change] ?? item.change}${item.conflict ? " (конфликт)" : ""}`}</td>
                </tr>
              ))}
              {(diff.data ?? []).length === 0 && (
                <tr><td className="empty-cell" colSpan={3}>Изменений нет</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
