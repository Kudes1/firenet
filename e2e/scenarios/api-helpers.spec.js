import { test, expect } from "@playwright/test";
import { login, createDraft, op, getTopology } from "../helpers/api.js";

test("draft создаётся и принимает операции", async ({ request }) => {
  await login(request);
  const id = await createDraft(request, "api-helpers");

  await op(request, id, { kind: "create-device", device: { name: "r1", kind: "router" } });

  const doc = await getTopology(request, id);
  expect(doc.topology.devices.map((d) => d.name)).toContain("r1");
});
