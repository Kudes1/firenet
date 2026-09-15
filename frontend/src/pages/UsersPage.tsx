import { useState } from "react";
import { api } from "../api/client";
import { useMe, useUsers } from "../api/queries";
import type { UserResponse, UserRole } from "../api/types";
import { containsFold } from "../lib/search";
import Modal from "../components/ui/Modal";
import DataTable, { type Column } from "../components/ui/DataTable";
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

  const forbidden = users.error instanceof Error && (users.error as { status?: number }).status === 403;
  const rows = users.data ?? [];

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

  const columns: Column<UserResponse>[] = [
    {
      key: "username",
      title: "Логин",
      width: "26%",
      minWidth: 180,
      render: (user) => user.username,
      filter: (user, query) => containsFold(user.username, query),
    },
    {
      key: "role",
      title: "Роль",
      width: "18%",
      minWidth: 140,
      render: (user) => user.id === me.data?.id
        ? <span className={`user-role user-role-${user.role}`}>{user.role}</span>
        : (
          <select
            className="user-role-select"
            value={user.role}
            aria-label={`Роль пользователя ${user.username}`}
            onChange={(event) => void changeRole(user, event.target.value as UserRole)}
          >
            <option value="admin">admin</option>
            <option value="user">user</option>
          </select>
        ),
      filter: (user, query) => containsFold(user.role, query),
    },
    {
      key: "status",
      title: "Статус",
      width: "17%",
      minWidth: 130,
      render: (user) => (
        <span className={`badge badge-${user.activated ? "ok" : "warn"}`}>
          {user.activated ? "Активен" : "Ожидает"}
        </span>
      ),
      filter: (user, query) => containsFold(user.activated ? "Активен" : "Ожидает", query),
    },
    {
      key: "createdAt",
      title: "Создан",
      width: "21%",
      minWidth: 160,
      render: (user) => new Date(user.createdAt).toLocaleDateString("ru-RU"),
      filter: (user, query) => containsFold(new Date(user.createdAt).toLocaleDateString("ru-RU"), query),
    },
    {
      key: "actions",
      title: "",
      width: "18%",
      minWidth: 150,
      filterReset: true,
      render: (user) => (
        <div className="users-actions">
          {!user.activated && (
            <button
              type="button"
              className="btn-link user-invite-action"
              title={`Показать ссылку для ${user.username}`}
              onClick={() => void showInvite(user)}
            >
              Ссылка
            </button>
          )}
          {user.id !== me.data?.id && (
            <button
              type="button"
              className="icon-btn user-action delete"
              title={`Удалить пользователя ${user.username}`}
              aria-label={`Удалить пользователя ${user.username}`}
              onClick={() => void remove(user)}
            >
              <DeleteIcon />
            </button>
          )}
        </div>
      ),
    },
  ];

  if (forbidden) {
    return (
      <main className="page users-page" data-testid="page-users">
        <div className="banner error">Доступ только для администраторов</div>
      </main>
    );
  }

  return (
    <main className="page users-page" data-testid="page-users">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(user) => user.id}
        empty="Пользователей нет — добавьте первого"
        resizable
        storageKey="firenet:users:column-widths"
        hint={(
          <div className="users-heading">
            <h1>Пользователи</h1>
            <p className="hint">Учётные записи и ссылки приглашения.</p>
          </div>
        )}
        actions={<button type="button" className="primary" title="Добавить пользователя" onClick={() => setCreating(true)}>+ Пользователь</button>}
      />

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
