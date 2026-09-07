import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import * as fx from "../api/fixtures";

// Один обработчик на ресурс: тесты переопределяют его через
// server.use(...) там, где нужен нестандартный ответ.
export const handlers = [
  http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
  // DraftBanner читает текущую версию и сам драфт; без этих обработчиков
  // он считал бы активный драфт исчезнувшим и сбрасывал таб в read-only.
  http.get("/api/versions", () => HttpResponse.json([fx.versionInfoFixture])),
  http.get("/api/drafts/:id", () => HttpResponse.json(fx.draftFixture)),
  http.get("/api/versions/current/topology", () => HttpResponse.json(fx.topologyFixture)),
  http.get("/api/versions/current/subnets", () => HttpResponse.json(fx.subnetsFixture)),
  http.get("/api/versions/current/rules", () => HttpResponse.json(fx.policyFixture)),
  http.get("/api/versions/current/layout", () => HttpResponse.json(fx.layoutFixture)),
  http.get("/api/drafts/:id/topology", () => HttpResponse.json(fx.topologyFixture)),
  http.get("/api/drafts/:id/subnets", () => HttpResponse.json(fx.subnetsFixture)),
  http.get("/api/drafts/:id/rules", () => HttpResponse.json(fx.policyFixture)),
  http.get("/api/drafts/:id/layout", () => HttpResponse.json(fx.layoutFixture)),
  http.put("/api/drafts/:id/topology", () => HttpResponse.json(fx.topologyFixture)),
  http.post("/api/drafts/:id/topology/operations", () =>
    HttpResponse.json(fx.editorSnapshotFixture, { headers: { "X-Draft-Revision": "2" } })),
  http.post("/api/drafts/:id/topology/operations/batch", () =>
    HttpResponse.json(fx.editorSnapshotFixture, { headers: { "X-Draft-Revision": "2" } })),
];

export const server = setupServer(...handlers);
