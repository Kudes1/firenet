"use strict";

// Drafts page: list your own drafts (or everyone's, for an admin), create,
// delete, review a draft's diff against its base version (with conflicts
// highlighted), and — admin only — confirm one into a new version.
const Drafts = (() => {
  let me = null;
  let drafts = [];
  let all = false;
  let selected = null;
  let diffs = [];

  const CHANGE_LABELS = { added: "добавлено", modified: "изменено", removed: "удалено" };

  function renderTable() {
    const tbody = document.getElementById("drafts-table").querySelector("tbody");
    tbody.innerHTML = "";
    drafts.forEach((d) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = d.name;
      const owner = document.createElement("td");
      owner.textContent = d.owner;
      const base = document.createElement("td");
      base.textContent = d.baseVersion;
      const status = document.createElement("td");
      status.textContent = d.status;
      const actions = document.createElement("td");

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "Открыть";
      openBtn.addEventListener("click", () => selectDraft(d));

      const diffBtn = document.createElement("button");
      diffBtn.type = "button";
      diffBtn.textContent = "Изменения";
      diffBtn.addEventListener("click", () => loadDiff(d));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "Удалить";
      delBtn.addEventListener("click", () => deleteDraft(d.id));

      actions.append(openBtn, diffBtn, delBtn);
      tr.append(name, owner, base, status, actions);
      tbody.append(tr);
    });
  }

  function renderDiff() {
    const panel = document.getElementById("diff-panel");
    if (!selected) { panel.hidden = true; return; }
    document.getElementById("diff-draft-name").textContent = "— " + selected.name;
    const body = document.getElementById("diff-body");
    body.innerHTML = "";
    diffs.forEach((e) => {
      const tr = document.createElement("tr");
      if (e.conflict) tr.className = "conflict-row";
      const kind = document.createElement("td");
      kind.textContent = e.kind;
      const key = document.createElement("td");
      key.textContent = e.key;
      const change = document.createElement("td");
      change.textContent = (CHANGE_LABELS[e.change] || e.change) + (e.conflict ? " (конфликт)" : "");
      tr.append(kind, key, change);
      body.append(tr);
    });
    document.getElementById("confirm-btn").hidden = !(me && me.role === "admin");
    panel.hidden = false;
  }

  async function refresh() {
    try {
      drafts = await Api.get("/api/drafts" + (all ? "?all=1" : ""));
      renderTable();
    } catch (e) {
      showBanner("Не удалось загрузить список черновиков: " + e.message);
    }
  }

  function selectDraft(draft) {
    setCurrentDraftID(draft.id);
    window.location.href = "/ui/topology";
  }

  async function loadDiff(draft) {
    selected = draft;
    try {
      diffs = await Api.get(`/api/drafts/${draft.id}/diff`);
      renderDiff();
    } catch (e) {
      showBanner("Не удалось загрузить изменения: " + e.message);
    }
  }

  // deleteDraft/confirmSelected use a raw fetch instead of Api: DELETE has
  // no request body to route through Api.post/put, and a 409 confirm
  // response carries {conflicts: [...]}, not Api's generic {error: "..."}
  // shape — the same move users.js already makes for its admin-only DELETE.
  async function deleteDraft(id) {
    const draft = drafts.find((d) => d.id === id);
    if (!confirm(`Удалить черновик «${draft ? draft.name : id}»? Изменения будут потеряны.`)) return;
    const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
    if (res.status === 401) {
      window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
      return;
    }
    if (!res.ok) {
      showBanner("Не удалось удалить черновик: " + ((await res.json()).error || `HTTP ${res.status}`));
      return;
    }
    if (currentDraftID() === id) setCurrentDraftID(null);
    if (selected && selected.id === id) { selected = null; renderDiff(); }
    await refresh();
  }

  async function createDraft(name) {
    try {
      await Api.post("/api/drafts", { name });
      await refresh();
    } catch (e) {
      showBanner("Не удалось создать черновик: " + e.message);
    }
  }

  // confirmSelected submits the currently open diff's draft for admin
  // confirmation. A 409 means someone else confirmed a conflicting change
  // since the diff was loaded — re-fetch it so the now-current conflict
  // flags show, rather than building a second rendering path for the
  // (structurally different) conflict list the 409 body carries.
  async function confirmSelected() {
    if (!selected) return;
    const res = await fetch(`/api/drafts/${selected.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.status === 401) {
      window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
      return;
    }
    if (res.status === 409) {
      const body = await res.json();
      if (Array.isArray(body.conflicts)) {
        // pgstore.Confirm marks the draft's status "conflict" before
        // returning 409, so the table's status column is now stale too.
        showBanner("В черновике есть конфликты — проверьте их перед подтверждением.", "error");
        await loadDiff(selected);
        await refresh();
      } else {
        // Not every 409 is a conflict (revision mismatch, duplicate name,
        // a confirm race) — those carry a plain {error} body, not
        // {conflicts}, and there is nothing new to show in the diff.
        showBanner("Не удалось подтвердить черновик: " + (body.error || `HTTP ${res.status}`));
      }
      return;
    }
    if (!res.ok) {
      showBanner("Не удалось подтвердить черновик: " + ((await res.json()).error || `HTTP ${res.status}`));
      return;
    }
    const { version } = await res.json();
    showBanner(`Черновик подтверждён как версия ${version}`, "ok");
    if (currentDraftID() === selected.id) setCurrentDraftID(null);
    selected = null;
    renderDiff();
    await refresh();
  }

  function wireForm() {
    const form = document.getElementById("create-draft-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = form.name.value.trim();
      if (!name) return;
      await createDraft(name);
      form.reset();
    });
    document.getElementById("all-checkbox").addEventListener("change", (e) => {
      all = e.target.checked;
      refresh();
    });
    document.getElementById("confirm-btn").addEventListener("click", confirmSelected);
  }

  async function boot() {
    wireForm();
    try {
      me = await Api.get("/api/me");
    } catch (e) {
      showBanner("Не удалось определить пользователя: " + e.message);
      return;
    }
    document.getElementById("all-toggle").hidden = me.role !== "admin";
    await refresh();
  }

  return {
    boot, refresh, selectDraft, loadDiff, deleteDraft, createDraft, confirmSelected,
    get me() { return me; },
    get drafts() { return drafts; },
    get selected() { return selected; },
    get diffs() { return diffs; },
  };
})();

document.addEventListener("DOMContentLoaded", Drafts.boot);
