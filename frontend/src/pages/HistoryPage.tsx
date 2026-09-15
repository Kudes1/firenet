import { useState } from "react";
import { useMe, useRestoreVersion, useVersionDiff, useVersions } from "../api/queries";
import type { EntityDiff, VersionInfo } from "../api/types";
import { notify } from "../components/notify";
import DataTable, { type Column } from "../components/ui/DataTable";
import { containsFold } from "../lib/search";

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
  const columns: Column<VersionInfo>[] = [
    {
      key: "version",
      title: "Версия",
      width: "12%",
      minWidth: 100,
      render: (version) => <span className="history-version">{version.id}</span>,
      filter: (version, query) => String(version.id).includes(query.trim()),
    },
    {
      key: "date",
      title: "Дата",
      width: "21%",
      minWidth: 190,
      render: (version) => new Date(version.createdAt).toLocaleString("ru-RU"),
      filter: (version, query) => containsFold(new Date(version.createdAt).toLocaleString("ru-RU"), query),
    },
    {
      key: "confirmedBy",
      title: "Подтвердил",
      width: "17%",
      minWidth: 150,
      render: (version) => version.confirmedBy || "—",
      filter: (version, query) => containsFold(version.confirmedBy, query),
    },
    {
      key: "note",
      title: "Заметка",
      width: "28%",
      minWidth: 220,
      render: (version) => version.note || "—",
      filter: (version, query) => containsFold(version.note, query),
    },
    {
      key: "actions",
      title: "",
      width: "22%",
      minWidth: 220,
      filterReset: true,
      render: (version) => (
        <div className="history-actions">
          <button
            type="button"
            className="secondary"
            title={`Дифф версии ${version.id}`}
            onClick={() => setDiffFor(diffFor === version.id ? null : version.id)}
          >
            Дифф
          </button>
          {isAdmin && previousOf(version.id) && (
            <button
              type="button"
              className="primary"
              title={`Восстановить версию ${version.id}`}
              onClick={() => onRestore(version.id)}
            >
              Восстановить
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <main className="page history-page" data-testid="page-history">
      <DataTable
        id="history-table"
        columns={columns}
        rows={list}
        rowKey={(version) => String(version.id)}
        empty="Версий нет"
        resizable
        storageKey="firenet:history:column-widths"
        hint={(
          <div className="history-heading">
            <h1>История версий</h1>
            <p className="hint">Подтверждённые версии проекта.</p>
          </div>
        )}
      />

      {diffFor !== null && (
        <div className="page-panel history-diff-panel" id="diff-panel" data-testid="diff-panel">
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
