// internal/httpapi/web/users.js
"use strict";

import { Api, showBanner, containsFold } from "./common.js";
import * as Table from "./table.js";

const USERS_COL_WIDTHS_KEY = "firenet-users-col-widths-v1";
const USERS_COL_WIDTHS_VERSION = 1;

document.addEventListener("alpine:init", () => {
  Alpine.data("usersPage", () => ({
    users: [], // {id, username, role, activated, createdAt}
    currentUserId: "",
    loaded: false,
    forbidden: false,
    saving: false,
    filters: { username: "" },
    searchOpen: false,
    createDraft: { username: "", role: "user" },
    editDraft: { id: "", username: "", role: "user" },
    inviteUrl: "",
    inviteUsername: "",

    async init() {
      try {
        const [users, me] = await Promise.all([Api.get("/api/users"), Api.get("/api/me")]);
        this.users = users;
        this.currentUserId = me.id;
        this.loaded = true;
        this.$nextTick(() => this.initTable(this.$refs.table));
      } catch (e) {
        if (e.status === 403) {
          this.forbidden = true;
          return;
        }
        showBanner("Не удалось загрузить пользователей: " + e.message);
      }
    },

    initTable(tableEl) {
      Table.initTable(tableEl, USERS_COL_WIDTHS_KEY, USERS_COL_WIDTHS_VERSION);
    },

    get filteredUsers() {
      return this.users.filter((u) => Table.matchAll(u, this.filters, {
        username: (x, q) => containsFold(x.username, q),
      }));
    },

    formatDate(iso) {
      return new Date(iso).toLocaleDateString("ru-RU");
    },

    openCreate() {
      this.createDraft = { username: "", role: "user" };
      this.$refs.createDialog.showModal();
    },

    get createHint() {
      const name = this.createDraft.username.trim();
      if (!name) return "Укажите логин";
      if (this.users.some((u) => u.username === name)) return `Логин ${name} уже используется`;
      return "";
    },

    async submitCreate() {
      if (this.createHint || this.saving) return;
      this.saving = true;
      try {
        const { user, inviteUrl } = await Api.post("/api/users", {
          username: this.createDraft.username.trim(),
          role: this.createDraft.role,
        });
        this.users.push(user);
        this.$refs.createDialog.close();
        this.showInvite(user.username, inviteUrl);
        showBanner("Пользователь создан", "ok");
      } catch (e) {
        showBanner("Ошибка создания: " + e.message);
      } finally {
        this.saving = false;
      }
    },

    openEdit(u) {
      this.editDraft = { id: u.id, username: u.username, role: u.role };
      this.$refs.editDialog.showModal();
    },

    async submitEdit() {
      if (this.saving) return;
      this.saving = true;
      try {
        const updated = await Api.patch(`/api/users/${this.editDraft.id}`, { role: this.editDraft.role });
        const i = this.users.findIndex((u) => u.id === updated.id);
        if (i >= 0) this.users[i] = updated;
        this.$refs.editDialog.close();
        showBanner("Роль обновлена", "ok");
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      } finally {
        this.saving = false;
      }
    },

    async openInviteFor(u) {
      try {
        const { inviteUrl } = await Api.post(`/api/users/${u.id}/invite`, {});
        this.showInvite(u.username, inviteUrl);
      } catch (e) {
        showBanner("Не удалось получить ссылку: " + e.message);
      }
    },

    showInvite(username, url) {
      this.inviteUsername = username;
      this.inviteUrl = url;
      this.$refs.inviteDialog.showModal();
    },

    async copyInviteUrl() {
      try {
        await navigator.clipboard.writeText(this.inviteUrl);
        showBanner("Ссылка скопирована", "ok");
      } catch (e) {
        showBanner("Не удалось скопировать: " + e.message);
      }
    },

    async removeUser(u) {
      if (!confirm(`Удалить пользователя «${u.username}»?`)) return;
      try {
        await Api.delete(`/api/users/${u.id}`);
        this.users = this.users.filter((x) => x.id !== u.id);
        showBanner("Пользователь удалён", "ok");
      } catch (e) {
        showBanner("Ошибка удаления: " + e.message);
      }
    },
  }));
});
