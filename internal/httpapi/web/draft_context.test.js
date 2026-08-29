"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Загружает свежий экземпляр модуля (cache-busting) с глобальными
// sessionStorage/localStorage над переданными хранилищами. Функции модуля
// читают глобальные объекты в момент вызова, поэтому при работе с двумя
// «вкладками» тест должен вернуть нужные глобальные объекты через `session`.
async function loadCommon(store = {}, localStore = {}) {
  global.document = { addEventListener() {} };
  global.window = {};
  global.localStorage = {
    getItem: (k) => (k in localStore ? localStore[k] : null),
    setItem: (k, v) => { localStore[k] = v; },
    removeItem: (k) => { delete localStore[k]; },
  };
  global.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  global.matchMedia = () => ({ matches: false });
  const names = await import(path.join(__dirname, "common.js") + `?t=${Date.now()}-${Math.random()}`);
  return { ...names, session: global.sessionStorage, store, localStore };
}

(async () => {
test("currentDraftID/setCurrentDraftID round-trip through sessionStorage", async () => {
  const { currentDraftID, setCurrentDraftID, store } = await loadCommon();
  assert.equal(currentDraftID(), null);
  setCurrentDraftID("draft-1");
  assert.equal(store["firenet-draft-id"], "draft-1");
  assert.equal(currentDraftID(), "draft-1");
  setCurrentDraftID(null);
  assert.equal(currentDraftID(), null);
});

test("currentDraftID restores the last draft from localStorage in a new session", async () => {
  const { currentDraftID } = await loadCommon({}, { "firenet-last-draft-id": "draft-1" });
  assert.equal(currentDraftID(), "draft-1");
});

test("restored draft remains fixed in its tab after another tab selects a draft", async () => {
  const localStore = { "firenet-last-draft-id": "draft-a" };
  const firstTab = await loadCommon({}, localStore);
  assert.equal(firstTab.currentDraftID(), "draft-a");

  const secondTab = await loadCommon({}, localStore);
  secondTab.setCurrentDraftID("draft-b");

  // модуль видит глобальные хранилища в момент вызова — вернуть окружение
  // первой вкладки перед её проверкой
  global.sessionStorage = firstTab.session;
  assert.equal(firstTab.currentDraftID(), "draft-a");
});

test("setCurrentDraftID stores the active draft as the last draft", async () => {
  const { setCurrentDraftID, localStore } = await loadCommon();
  setCurrentDraftID("draft-1");
  assert.equal(localStore["firenet-last-draft-id"], "draft-1");
});

test("clearing the active draft clears its persisted last-draft value", async () => {
  const { setCurrentDraftID, localStore } = await loadCommon(
    { "firenet-draft-id": "draft-1" },
    { "firenet-last-draft-id": "draft-1" },
  );
  setCurrentDraftID(null);
  assert.equal(localStore["firenet-last-draft-id"], undefined);
});

test("clearing a tab draft keeps another last draft and makes the tab read-only", async () => {
  const { currentDraftID, setCurrentDraftID, localStore } = await loadCommon(
    { "firenet-draft-id": "draft-a" },
    { "firenet-last-draft-id": "draft-b" },
  );
  setCurrentDraftID(null);
  assert.equal(currentDraftID(), null);
  assert.equal(localStore["firenet-last-draft-id"], "draft-b");
});

test("isReadOnly reflects whether a draft is active", async () => {
  const { isReadOnly, setCurrentDraftID } = await loadCommon();
  assert.equal(isReadOnly(), true);
  setCurrentDraftID("draft-1");
  assert.equal(isReadOnly(), false);
});

test("apiPath routes to the active draft, or the current version otherwise", async () => {
  const { apiPath, setCurrentDraftID } = await loadCommon();
  assert.equal(apiPath("topology"), "/api/versions/current/topology");
  setCurrentDraftID("draft-1");
  assert.equal(apiPath("topology"), "/api/drafts/draft-1/topology");
  assert.equal(apiPath("link-exports?link=0&side=a"), "/api/drafts/draft-1/link-exports?link=0&side=a");
});

test("assertEditable throws ReadOnlyError only when read-only", async () => {
  const { assertEditable, setCurrentDraftID, ReadOnlyError } = await loadCommon();
  assert.throws(() => assertEditable(), ReadOnlyError);
  setCurrentDraftID("draft-1");
  assert.doesNotThrow(() => assertEditable());
});

test("Api.put sends the revision from the last Api.get and updates it from the response", async () => {
  const { Api } = await loadCommon({ "firenet-draft-id": "draft-1" });
  const requests = [];
  global.fetch = async (url, opts) => {
    requests.push({ url, headers: opts?.headers || {} });
    if (!opts) {
      return { ok: true, status: 200, headers: { get: (h) => (h === "X-Draft-Revision" ? "3" : null) }, json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: (h) => (h === "X-Draft-Revision" ? "4" : null) }, json: async () => ({}) };
  };
  await Api.get("/api/drafts/draft-1/topology");
  await Api.put("/api/drafts/draft-1/topology", { devices: [] });
  assert.equal(requests[1].headers["X-Draft-Revision"], "3");

  await Api.put("/api/drafts/draft-1/topology", { devices: [] });
  assert.equal(requests[2].headers["X-Draft-Revision"], "4");
});

test("Api.post sends the revision from the last Api.get and updates it from the response", async () => {
  const { Api } = await loadCommon({ "firenet-draft-id": "draft-1" });
  const requests = [];
  global.fetch = async (url, opts) => {
    requests.push({ url, headers: opts?.headers || {} });
    if (!opts) {
      return { ok: true, status: 200, headers: { get: (h) => (h === "X-Draft-Revision" ? "3" : null) }, json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: (h) => (h === "X-Draft-Revision" ? "4" : null) }, json: async () => ({}) };
  };
  await Api.get("/api/drafts/draft-1/topology");
  await Api.post("/api/drafts/draft-1/topology/operations", { kind: "create-device" });
  assert.equal(requests[1].headers["X-Draft-Revision"], "3");

  await Api.post("/api/drafts/draft-1/topology/operations", { kind: "create-device" });
  assert.equal(requests[2].headers["X-Draft-Revision"], "4");
});
})();
