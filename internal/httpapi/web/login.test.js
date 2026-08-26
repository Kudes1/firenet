"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadLogin() {
  const sandbox = {
    document: { addEventListener() {} },
    URLSearchParams: require("node:url").URLSearchParams,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "login.js"), "utf8"), sandbox, { filename: "login.js" });
  return vm.runInContext("({ loginRedirectTarget })", sandbox);
}

test("loginRedirectTarget defaults to topology when next is missing", () => {
  const { loginRedirectTarget } = loadLogin();
  assert.equal(loginRedirectTarget(""), "/ui/topology");
});

test("loginRedirectTarget accepts a same-origin path", () => {
  const { loginRedirectTarget } = loadLogin();
  assert.equal(loginRedirectTarget("?next=%2Fui%2Frules"), "/ui/rules");
});

test("loginRedirectTarget rejects a protocol-relative next", () => {
  const { loginRedirectTarget } = loadLogin();
  assert.equal(loginRedirectTarget("?next=%2F%2Fevil.com"), "/ui/topology");
});

test("loginRedirectTarget rejects an absolute URL", () => {
  const { loginRedirectTarget } = loadLogin();
  assert.equal(loginRedirectTarget("?next=https%3A%2F%2Fevil.com"), "/ui/topology");
});
