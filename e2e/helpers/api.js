import fs from "node:fs";

export function env() {
  return JSON.parse(fs.readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8"));
}

const base = () => env().baseURL;

async function ensureOk(res, what) {
  if (!res.ok()) throw new Error(`${what}: ${res.status()} ${await res.text()}`);
  return res;
}

export async function login(request) {
  const { admin } = env();
  await ensureOk(await request.post(base() + "/api/login", { data: admin }), "login");
}

export async function createDraft(request, name) {
  const res = await ensureOk(
    await request.post(base() + "/api/drafts", { data: { name } }), "createDraft");
  return (await res.json()).id;
}

export async function op(request, draftId, body) {
  const res = await ensureOk(
    await request.post(`${base()}/api/drafts/${draftId}/topology/operations`, { data: body }),
    `op ${body.kind}`);
  return res.json();
}

async function get(request, path) {
  const res = await ensureOk(await request.get(base() + path), "GET " + path);
  return res.json();
}

export async function getTopology(request, id) {
  const doc = await get(request, `/api/drafts/${id}/topology`);
  return doc.topology ? doc : { topology: doc };
}

export const getSubnets = (request, id) => get(request, `/api/drafts/${id}/subnets`);
export const getRules = (request, id) => get(request, `/api/drafts/${id}/rules`);

export async function putSubnets(request, id, subnets) {
  await ensureOk(
    await request.put(`${base()}/api/drafts/${id}/subnets`, { data: { subnets } }),
    "putSubnets");
}

export async function putRules(request, id, chains) {
  await ensureOk(
    await request.put(`${base()}/api/drafts/${id}/rules`, { data: { chains } }),
    "putRules");
}

export async function putTopology(request, id, topology) {
  await ensureOk(
    await request.put(`${base()}/api/drafts/${id}/topology`, { data: topology }),
    "putTopology");
}
