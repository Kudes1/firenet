import { useState } from "react";
import { api } from "../api/client";
import { useMe, useUsers } from "../api/queries";
import type { UserResponse, UserRole } from "../api/types";
import { containsFold } from "../lib/search";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { DeleteIcon } from "../components/icons";

type Invite = { username: string; url: string };

export default function UsersPage() {
  const users = useUsers();
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("user");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [filter, setFilter] = useState("");

  const forbidden = users.error instanceof Error && (users.error as { status?: number }).status === 403;
  const rows = (users.data ?? []).filter((u) => containsFold(u.username, filter));

  const create = async () => {
    try {
      const result = await api.post<{ user: UserResponse; inviteUrl: string }>("/api/users", {
        username: newName.trim(), role: newRole,
      });
      setInvite({ username: result.user.username, url: result.inviteUrl });
      setCreating(false);
      setNewName("");
      void users.refetch();
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const changeRole = async (user: UserResponse, role: UserRole) => {
    try {
      await api.patch(`/api/users/${user.id}`, { role });
      void users.refetch();
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const remove = async (user: UserResponse) => {
    if (!window.confirm(`Удалить пользователя ${user.username}?`)) return;
    try {
      await api.del(`/api/users/${user.id}`);
      void users.refetch();
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const showInvite = async (user: UserResponse) => {
    try {
      const result = await api.post<{ inviteUrl: string }>(`/api/users/${user.id}/invite`, {});
      setInvite({ username: user.username, url: result.inviteUrl });
    } catch (error) {
      notify((error as Error).message);
    }
  };

  if (forbidden) {
    return (
      <main className="page" data-testid="page-users">
        <div className="banner error">Доступ только для администраторов</div>
      </main>
    );
  }

  return (
    <main className="page" data-testid="page-users">
      <div className="table-toolbar">
        <div className="toolbar-text">
          <h3>Пользователи</h3>
          <p className="hint">Учётные записи и ссылки приглашения.</p>
        </div>
        <div className="toolbar-actions">
          <input placeholder="логин" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="primary" title="Добавить пользователя" onClick={() => setCreating(true)}>+ Пользователь</button>
        </div>
      </div>

      <table className="data-table">
        <thead><tr><th>Логин</th><th>Роль</th><th>Статус</th><th>Создан</th><th /></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>
                {u.id === me.data?.id ? u.role : (
                  <select value={u.role} onChange={(e) => changeRole(u, e.target.value as UserRole)}>
                    <option value="admin">admin</option>
                    <option value="user">user</option>
                  </select>
                )}
              </td>
              <td>
                <span className={`badge badge-${u.activated ? "ok" : "warn"}`}>{u.activated ? "Активен" : "Ожидает"}</span>
              </td>
              <td>{new Date(u.createdAt).toLocaleDateString("ru-RU")}</td>
              <td>
                {!u.activated && (
                  <button type="button" className="btn-link" title={`Показать ссылку для ${u.username}`} onClick={() => showInvite(u)}>Ссылка</button>
                )}
                {u.id !== me.data?.id && (
                  <button type="button" className="icon-btn delete" title={`Удалить пользователя ${u.username}`} onClick={() => remove(u)}><DeleteIcon /></button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td className="empty-cell" colSpan={5}>Пользователей нет</td></tr>
          )}
        </tbody>
      </table>

      <Modal
        open={creating}
        title="Новый пользователь"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button type="button" onClick={() => setCreating(false)}>Отмена</button>
            <button type="button" className="primary" disabled={!newName.trim()} onClick={create}>Создать</button>
          </>
        }
      >
        <div className="modal-grid">
          <label>
            Логин
            <input value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <label>
            Роль
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
              <option value="admin">admin</option>
              <option value="user">user</option>
            </select>
          </label>
        </div>
      </Modal>

      <Modal
        open={!!invite}
        title={`Ссылка приглашения: ${invite?.username ?? ""}`}
        onClose={() => setInvite(null)}
        footer={<button type="button" onClick={() => setInvite(null)}>Закрыть</button>}
      >
        <div className="modal-grid">
          <input readOnly value={invite?.url ?? ""} />
          <button
            type="button"
            onClick={() => { if (invite) void navigator.clipboard.writeText(invite.url); }}
          >
            Копировать
          </button>
        </div>
      </Modal>
    </main>
  );
}
