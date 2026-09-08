import { useState } from "react";
import { useMe, useRestoreVersion, useVersionDiff, useVersions } from "../api/queries";
import type { EntityDiff, VersionInfo } from "../api/types";
import { notify } from "../components/notify";

const CHANGE_LABEL: Record<string, string> = {
  added: "добавлено", modified: "изменено", removed: "удалено",
};

export default function HistoryPage() {
  const versions = useVersions(50);
  const me = useMe();
  const restore = useRestoreVersion();
  const [diffFor, setDiffFor] = useState<number | null>(null);

  const list = versions.data ?? [];
  // Дифф всегда с предыдущей версией в списке (он идёт следующим).
  const previousOf = (id: number) => {
    const index = list.findIndex((v) => v.id === id);
    return index >= 0 ? list[index + 1] : undefined;
  };
  const previous = diffFor === null ? undefined : previousOf(diffFor);
  const diff = useVersionDiff(previous?.id ?? null, diffFor);

  const onRestore = async (id: number) => {
    if (!window.confirm(`Восстановить версию ${id}? Будет создана новая версия.`)) return;
    try {
      const result = await restore.mutateAsync(id);
      notify(`Создана версия ${result.version}`, "ok");
      setDiffFor(null);
      void versions.refetch();
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const isAdmin = me.data?.role === "admin";

  return (
    <main className="page" data-testid="page-history">
      <div className="table-toolbar">
        <div className="toolbar-text">
          <h3>История версий</h3>
          <p className="hint">Подтверждённые версии проекта.</p>
        </div>
      </div>
      <table className="data-table" id="history-table">
        <thead><tr><th>Версия</th><th>Дата</th><th>Подтвердил</th><th>Заметка</th><th /></tr></thead>
        <tbody>
          {list.map((v: VersionInfo) => (
            <tr key={v.id}>
              <td>{v.id}</td>
              <td>{new Date(v.createdAt).toLocaleString("ru-RU")}</td>
              <td>{v.confirmedBy || "—"}</td>
              <td>{v.note || "—"}</td>
              <td>
                <button type="button" className="btn-link" title={`Дифф версии ${v.id}`} onClick={() => setDiffFor(diffFor === v.id ? null : v.id)}>Дифф</button>
                {isAdmin && previousOf(v.id) && (
                  <button type="button" className="btn-link" title={`Восстановить версию ${v.id}`} onClick={() => onRestore(v.id)}>Восстановить</button>
                )}
              </td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr><td className="empty-cell" colSpan={5}>Версий нет</td></tr>
          )}
        </tbody>
      </table>

      {diffFor !== null && (
        <div className="page-panel" id="diff-panel" data-testid="diff-panel">
          <div className="lint-panel-header">
            <strong>{`Версия ${diffFor} против ${previous?.id ?? "—"}`}</strong>
            <button type="button" className="lint-panel-close" onClick={() => setDiffFor(null)}>×</button>
          </div>
          <table className="data-table" id="diff-body">
            <thead><tr><th>Тип</th><th>Ключ</th><th>Изменение</th></tr></thead>
            <tbody>
              {(diff.data ?? []).map((d, i) => {
                const item = d as EntityDiff;
                return (
                  <tr key={i} className={item.change === "removed" ? "conflict-row" : undefined}>
                    <td>{item.kind}</td>
                    <td>{item.key}</td>
                    <td>{CHANGE_LABEL[item.change] ?? item.change}</td>
                  </tr>
                );
              })}
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
