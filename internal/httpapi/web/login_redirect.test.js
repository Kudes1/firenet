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

  test("loginRedirectURL is idempotent when already on /login (doesn't nest next around itself)", async () => {
    const { loginRedirectURL } = await loadCommon();
    const once = loginRedirectURL("/ui/topology", "");
    assert.equal(once, "/login?next=%2Fui%2Ftopology");
    // Calling it again as if we were already on the URL it just produced
    // must return the same URL, not wrap it in another layer of /login?next=.
    assert.equal(loginRedirectURL("/login", "?next=%2Fui%2Ftopology"), once);
  });

  test("concurrent 401s from a page's parallel API calls navigate only once", async () => {
    // A real page load fires several API calls in parallel; an expired
    // session 401s all of them around the same time. Each one used to read
    // window.location and navigate independently, which is what produced
    // the nested next= chains in practice, not a single caller re-wrapping
    // its own output.
    global.document = { addEventListener() {} };
    const hrefs = [];
    global.window = {
      location: {
        pathname: "/ui/topology",
        search: "",
        set href(v) { hrefs.push(v); },
        get href() { return hrefs[hrefs.length - 1] ?? ""; },
      },
    };
    global.localStorage = { getItem: () => null, setItem() {} };
    global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    global.matchMedia = () => ({ matches: false });
    global.fetch = () => Promise.resolve({ status: 401, ok: false });

    const { Api } = await import(path.join(__dirname, "common.js") + `?t=${Date.now()}-${Math.random()}`);
    Api.get("/api/versions/current/topology");
    Api.get("/api/versions/current/subnets");
    Api.get("/api/versions/current/layout");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(hrefs, ["/login?next=%2Fui%2Ftopology"]);
  });
})();
