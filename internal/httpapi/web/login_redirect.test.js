"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function loadCommon() {
  global.document = { addEventListener() {} };
  global.window = {};
  global.localStorage = { getItem: () => null, setItem() {} };
  global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.matchMedia = () => ({ matches: false });
  return import(path.join(__dirname, "common.js"));
}

(async () => {
  test("loginRedirectURL preserves a same-origin path as next", async () => {
    const { loginRedirectURL } = await loadCommon();
    assert.equal(loginRedirectURL("/ui/rules", ""), "/login?next=%2Fui%2Frules");
  });

  test("loginRedirectURL drops a protocol-relative next", async () => {
    const { loginRedirectURL } = await loadCommon();
    assert.equal(loginRedirectURL("//evil.com", ""), "/login");
  });

  test("loginRedirectURL includes the query string in next", async () => {
    const { loginRedirectURL } = await loadCommon();
    assert.equal(loginRedirectURL("/ui/rules", "?chain=fwd"), "/login?next=%2Fui%2Frules%3Fchain%3Dfwd");
  });
})();
