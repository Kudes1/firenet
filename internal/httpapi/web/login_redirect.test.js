"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCommon() {
  const sandbox = {
    document: { addEventListener() {} },
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false }),
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), sandbox, { filename: "common.js" });
  return vm.runInContext("({ loginRedirectURL })", sandbox);
}

test("loginRedirectURL preserves a same-origin path as next", () => {
  const { loginRedirectURL } = loadCommon();
  assert.equal(loginRedirectURL("/ui/rules", ""), "/login?next=%2Fui%2Frules");
});

test("loginRedirectURL drops a protocol-relative next", () => {
  const { loginRedirectURL } = loadCommon();
  assert.equal(loginRedirectURL("//evil.com", ""), "/login");
});

test("loginRedirectURL includes the query string in next", () => {
  const { loginRedirectURL } = loadCommon();
  assert.equal(loginRedirectURL("/ui/rules", "?chain=fwd"), "/login?next=%2Fui%2Frules%3Fchain%3Dfwd");
});
