import fs from "node:fs";

export function env() {
  return JSON.parse(fs.readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8"));
}

const base = () => env().baseURL;

export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const userCreds = () => ({
  username: `e2e-user-${uid()}`,
  password: "e2e-user-password-1",
  role: "user",
});

export async function freshDraft(request, name) {
  await login(request);
  return createDraft(request, `${name}-${uid()}`);
}

async function ensureOk(res, what) {
  if (!res.ok()) throw new Error(`${what}: ${res.status()} ${await res.text()}`);
  return res;
}

export async function login(request, creds) {
  const c = creds || env().admin;
  await ensureOk(await request.post(base() + "/api/login", { data: c }), "login");
}

export async function registerUser(request, { username, password, role }) {
  const res = await ensureOk(
    await request.post(base() + "/api/users", { data: { username, role } }),
    "registerUser");
  const { inviteUrl } = await res.json();
  const token = new URL(inviteUrl).pathname.split("/").pop();
  await ensureOk(
    await request.post(`${base()}/api/invites/${token}`, { data: { password, confirmPassword: password } }),
    "activateUser");
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

export async function confirmDraft(request, id) {
  const res = await ensureOk(
    await request.post(`${base()}/api/drafts/${id}/confirm`, { data: {} }),
    "confirmDraft");
  return res.json(); // {version}
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
export const getLayout = (request, id) => get(request, `/api/drafts/${id}/layout`);
export const getVersions = (request) => get(request, "/api/versions");
export const getCurrentTopology = (request) =>
  get(request, "/api/versions/current/topology").then((doc) => (doc.topology ? doc : { topology: doc }));

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
