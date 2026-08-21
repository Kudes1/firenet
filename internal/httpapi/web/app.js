"use strict";

const Api = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) throw await apiError(res);
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? null : res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? null : res.json();
  },
};

async function apiError(res) {
  try {
    const data = await res.json();
    return new Error(data.error || `HTTP ${res.status}`);
  } catch {
    return new Error(`HTTP ${res.status}`);
  }
}

// State is the single in-memory source of truth for the currently open
// project; the Topology/Rules/Compile modules read and mutate it directly
// and persist it explicitly via Save actions (layout positions excepted,
// which autosave — see topology.js).
const State = {
  topology: { devices: [], links: [], subnets: [], zones: [] },
  rules: { defaultAction: "deny", rules: [] },
  layout: { devices: {}, subnets: {} },
};

function showBanner(message, kind) {
  const el = document.getElementById("error-banner");
  el.textContent = message;
  el.className = "banner " + (kind || "error");
  el.hidden = false;
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}

function setupTabs() {
  const buttons = document.querySelectorAll("nav.tabs button");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => {
        p.hidden = p.id !== "tab-" + btn.dataset.tab;
      });
    });
  });
}

async function boot() {
  setupTabs();
  try {
    State.topology = await Api.get("/api/topology");
  } catch (e) {
    showBanner("Не удалось загрузить топологию: " + e.message);
  }
  try {
    State.rules = await Api.get("/api/rules");
  } catch (e) {
    showBanner("Не удалось загрузить правила: " + e.message);
  }
  try {
    const layout = await Api.get("/api/layout");
    State.layout = { devices: layout.devices || {}, subnets: layout.subnets || {} };
  } catch {
    State.layout = { devices: {}, subnets: {} };
  }

  Topology.render();
  Rules.render();
}

document.addEventListener("DOMContentLoaded", boot);
