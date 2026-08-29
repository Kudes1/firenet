"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  global.document = { addEventListener() {} };
  const { loginRedirectTarget } = await import(path.join(__dirname, "login.js"));

  test("loginRedirectTarget defaults to topology when next is missing", () => {
    assert.equal(loginRedirectTarget(""), "/ui/topology");
  });

  test("loginRedirectTarget accepts a same-origin path", () => {
    assert.equal(loginRedirectTarget("?next=%2Fui%2Frules"), "/ui/rules");
  });

  test("loginRedirectTarget rejects a protocol-relative next", () => {
    assert.equal(loginRedirectTarget("?next=%2F%2Fevil.com"), "/ui/topology");
  });

  test("loginRedirectTarget rejects an absolute URL", () => {
    assert.equal(loginRedirectTarget("?next=https%3A%2F%2Fevil.com"), "/ui/topology");
  });
})();
