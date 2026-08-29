"use strict";

import { Api, showBanner, setCurrentDraftID } from "./common.js";

// Version history: the confirmed-version list, a diff of any entry against
// the one immediately before it, and — admin only — restoring an older
// version (which creates a new version on top, never rewrites history).
const History = (() => {
  let me = null;
  let versions = [];
  let selectedID = null;
  let diffs = [];

  const CHANGE_LABELS = { added: "добавлено", modified: "изменено", removed: "удалено" };

  function renderList() {
    const tbody = document.getElementById("history-table").querySelector("tbody");
    tbody.innerHTML = "";
    versions.forEach((v) => {
      const tr = document.createElement("tr");
      const id = document.createElement("td");
      id.textContent = v.id;
      const created = document.createElement("td");
      created.textContent = v.createdAt;
      const confirmedBy = document.createElement("td");
      confirmedBy.textContent = v.confirmedBy || "";
      const note = document.createElement("td");
      note.textContent = v.note || "";
      const actions = document.createElement("td");

      const diffBtn = document.createElement("button");
      diffBtn.type = "button";
      diffBtn.textContent = "Дифф";
      diffBtn.addEventListener("click", () => showDiff(v.id));
      actions.append(diffBtn);

      if (me && me.role === "admin") {
        const restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.textContent = "Восстановить";
        restoreBtn.addEventListener("click", () => restore(v.id));
        actions.append(restoreBtn);
      }

      tr.append(id, created, confirmedBy, note, actions);
      tbody.append(tr);
    });
  }

  function renderDiff() {
    const panel = document.getElementById("diff-panel");
    if (selectedID === null) { panel.hidden = true; return; }
    document.getElementById("diff-version-label").textContent = "— версия " + selectedID;
    const body = document.getElementById("diff-body");
    body.innerHTML = "";
    diffs.forEach((e) => {
      const tr = document.createElement("tr");
      const kind = document.createElement("td");
      kind.textContent = e.kind;
      const key = document.createElement("td");
      key.textContent = e.key;
      const change = document.createElement("td");
      change.textContent = CHANGE_LABELS[e.change] || e.change;
      tr.append(kind, key, change);
      body.append(tr);
    });
    panel.hidden = false;
  }

  async function refresh() {
    try {
      versions = await Api.get("/api/versions?limit=50");
      renderList();
    } catch (e) {
      showBanner("Не удалось загрузить историю версий: " + e.message);
    }
  }

  // showDiff compares a version to the one immediately before it in this
  // (newest-first) list — the version's own predecessor isn't known to the
  // caller beyond what this list already shows. The oldest listed entry has
  // no older neighbor here, so it diffs against itself (an empty diff).
  async function showDiff(id) {
    const idx = versions.findIndex((v) => v.id === id);
    const from = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1].id : id;
    selectedID = id;
    try {
      diffs = await Api.get(`/api/versions/diff?from=${from}&to=${id}`);
      renderDiff();
    } catch (e) {
      showBanner("Не удалось загрузить изменения: " + e.message);
    }
  }

  async function restore(id) {
    if (!confirm(`Восстановить версию ${id}? Будет создана новая версия.`)) return;
    try {
      const result = await Api.post(`/api/versions/${id}/restore`, {});
      setCurrentDraftID(null);
      showBanner(`Создана версия ${result.version}`, "ok");
      await refresh();
    } catch (e) {
      showBanner("Не удалось восстановить версию: " + e.message);
    }
  }

  async function boot() {
    try {
      me = await Api.get("/api/me");
    } catch (e) {
      showBanner("Не удалось определить пользователя: " + e.message);
      return;
    }
    await refresh();
  }

  return {
    boot, refresh, showDiff, restore,
    get me() { return me; },
    get versions() { return versions; },
    get selectedID() { return selectedID; },
    get diffs() { return diffs; },
  };
})();

export { History };

document.addEventListener("DOMContentLoaded", History.boot);
