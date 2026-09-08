import { useState } from "react";
import {
  useConfirmDraft, useCreateDraft, useDeleteDraft, useDraftDiff, useDrafts, useMe,
} from "../api/queries";
import type { DraftDiffEntry, DraftResponse } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { notify } from "../components/notify";
import { DeleteIcon } from "../components/icons";

const CHANGE_LABEL: Record<string, string> = { added: "добавлено", modified: "изменено", removed: "удалено" };

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

  return (
    <main className="page" data-testid="page-drafts">
      <div className="table-toolbar">
        <div className="toolbar-text">
          <h3>Черновики</h3>
          <p className="hint">Личные черновики и их подтверждение.</p>
        </div>
        {me.data?.role === "admin" && (
          <label className="modal-check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Показывать все
          </label>
        )}
      </div>

      <form
        id="create-draft-form"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement;
          void onCreate(input.value);
          input.value = "";
        }}
      >
        <label>
          Название
          <input name="name" required placeholder="правки для офиса" />
        </label>
        <button type="submit">Создать</button>
      </form>

      <table className="data-table" id="drafts-table">
        <thead><tr><th>Название</th><th>Автор</th><th>База</th><th>Статус</th><th /></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>{d.owner}</td>
              <td>{d.baseVersion}</td>
              <td>{d.status}</td>
              <td>
                <button type="button" className="btn-link" title={`Открыть черновик ${d.name}`} onClick={() => setDraftId(d.id)}>Открыть</button>
                <button type="button" className="btn-link" title={`Изменения черновика ${d.name}`} onClick={() => setDiffFor(diffFor === d.id ? null : d.id)}>Изменения</button>
                {me.data?.role === "admin" && d.status !== "merged" && (
                  <button type="button" className="btn-link" title={`Подтвердить черновик ${d.name}`} onClick={() => onConfirm(d)}>Подтвердить</button>
                )}
                <button type="button" className="icon-btn delete" title={`Удалить черновик ${d.name}`} onClick={() => onDelete(d)}><DeleteIcon /></button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td className="empty-cell" colSpan={5}>Черновиков нет</td></tr>
          )}
        </tbody>
      </table>

      {diffFor && (
        <div className="page-panel" id="diff-panel" data-testid="diff-panel">
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
