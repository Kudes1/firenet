"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCommon(store = {}) {
  const sandbox = {
    document: { addEventListener() {} },
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: false }),
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), sandbox, { filename: "common.js" });
  const names = vm.runInContext("({ currentDraftID, setCurrentDraftID, isReadOnly, apiPath, assertEditable, ReadOnlyError, Api })", sandbox);
  return { ...names, sandbox, store };
}

test("currentDraftID/setCurrentDraftID round-trip through sessionStorage", () => {
  const { currentDraftID, setCurrentDraftID, store } = loadCommon();
  assert.equal(currentDraftID(), null);
  setCurrentDraftID("draft-1");
  assert.equal(store["firenet-draft-id"], "draft-1");
  assert.equal(currentDraftID(), "draft-1");
  setCurrentDraftID(null);
  assert.equal(currentDraftID(), null);
});

test("isReadOnly reflects whether a draft is active", () => {
  const { isReadOnly, setCurrentDraftID } = loadCommon();
  assert.equal(isReadOnly(), true);
  setCurrentDraftID("draft-1");
  assert.equal(isReadOnly(), false);
});

test("apiPath routes to the active draft, or the current version otherwise", () => {
  const { apiPath, setCurrentDraftID } = loadCommon();
  assert.equal(apiPath("topology"), "/api/versions/current/topology");
  setCurrentDraftID("draft-1");
  assert.equal(apiPath("topology"), "/api/drafts/draft-1/topology");
  assert.equal(apiPath("link-exports?link=0&side=a"), "/api/drafts/draft-1/link-exports?link=0&side=a");
});

test("assertEditable throws ReadOnlyError only when read-only", () => {
  const { assertEditable, setCurrentDraftID, ReadOnlyError } = loadCommon();
  assert.throws(() => assertEditable(), ReadOnlyError);
  setCurrentDraftID("draft-1");
  assert.doesNotThrow(() => assertEditable());
});

test("Api.put sends the revision from the last Api.get and updates it from the response", async () => {
  const { Api, sandbox } = loadCommon({ "firenet-draft-id": "draft-1" });
  const requests = [];
  sandbox.fetch = async (url, opts) => {
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
