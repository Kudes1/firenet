import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, loginRedirectURL, resetApiState } from "./client";
import { getRevision } from "./revision";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("loginRedirectURL", () => {
  it("preserves a safe absolute path as ?next", () => {
    expect(loginRedirectURL("/ui/rules", "?q=1")).toBe("/login?next=%2Fui%2Frules%3Fq%3D1");
  });
  it("drops an open redirect", () => {
    expect(loginRedirectURL("//evil.example", "")).toBe("/login");
  });
  it("does not nest when already on /login", () => {
    expect(loginRedirectURL("/login", "")).toBe("/login");
  });
});

describe("api", () => {
  beforeEach(() => {
    resetApiState();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parses JSON and records the revision header", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: 1 }, 200, { "X-Draft-Revision": "5" }));
    const data = await api.get<{ ok: number }>("/api/drafts/d1/topology");
    expect(data).toEqual({ ok: 1 });
    expect(getRevision()).toBe("5");
  });

  it("sends X-Draft-Revision on mutations", async () => {
    // Свежий Response на каждый вызов: тело Response читается один раз,
    // а здесь два запроса получают один и тот же мок.
    vi.mocked(fetch).mockImplementation(async () => jsonResponse({ ok: 1 }, 200, { "X-Draft-Revision": "5" }));
    await api.get("/api/x");
    await api.put("/api/y", { a: 1 });
    const [, init] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect((init!.headers as Record<string, string>)["X-Draft-Revision"]).toBe("5");
  });

  it("keeps the stored revision when a response has no header", async () => {
    // Как в common.js: не-драфтовый ответ без заголовка не стирает токен.
    vi.mocked(fetch)
      .mockImplementationOnce(async () => jsonResponse({ ok: 1 }, 200, { "X-Draft-Revision": "5" }))
      .mockImplementationOnce(async () => jsonResponse({ ok: 1 }));
    await api.get("/api/drafts/d1/topology");
    await api.get("/api/users");
    expect(getRevision()).toBe("5");
  });

  it("raises ApiError with the server message", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "name is required" }, 400));
    await expect(api.get("/api/x")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "name is required",
    });
  });

  it("redirects to /login on 401 and never resolves", async () => {
    delete (window as { location?: unknown }).location;
    (window as { location?: unknown }).location = { href: "", pathname: "/ui/links", search: "" };
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "authentication required" }, 401));
    const pending = api.get("/api/x");
    await expect(Promise.race([pending, Promise.resolve("resolved")])).resolves.toBe("resolved");
    expect(window.location.href).toBe("/login?next=%2Fui%2Flinks");
  });

  it("surfaces 401 on /login as a catchable ApiError (bad credentials)", async () => {
    delete (window as { location?: unknown }).location;
    (window as { location?: unknown }).location = { href: "", pathname: "/login", search: "" };
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "invalid username or password" }, 401));
    const err = await api.post("/api/login", { username: "admin", password: "wrong" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(window.location.href).toBe("");
  });

  it("surfaces 409 as a catchable ApiError", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "draft was changed" }, 409));
    const err = await api.put("/api/x", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
  });
});
