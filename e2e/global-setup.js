import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const ENV_FILE = new URL("./.e2e-env.json", import.meta.url);
const PG = { user: "firenet", pass: "e2e-pass", db: "firenet" };
const ADMIN = { username: "e2e-admin", password: "e2e-admin-password-1" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor(label, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch (e) { /* ещё не готово */ }
    if (Date.now() > deadline) throw new Error(`e2e setup: ${label} не готов за ${timeoutMs}мс`);
    await sleep(500);
  }
}

export async function waitForPostgres(container) {
  await waitFor("Postgres", () => {
    // -h 127.0.0.1 проверяет именно TCP-слушателя: unix-сокет готов раньше,
    // и без -h сервер может сделать одиночный ping в недоступное TCP и умереть.
    execSync(`docker exec ${container} pg_isready -h 127.0.0.1 -U ${PG.user} -d ${PG.db}`, { stdio: "pipe" });
    return true;
  });
}

export function cleanupSetupResources(container, server) {
  if (server?.pid) {
    try { process.kill(server.pid, "SIGTERM"); } catch { /* уже умер */ }
  }
  if (container) {
    try { execSync(`docker rm -f ${container}`, { stdio: "pipe" }); } catch { /* уже удалён */ }
  }
}

export default async function globalSetup() {
  let container;
  let server;
  try {
    const pgPort = await freePort();
    container = `firenet-e2e-pg-${Date.now()}`;
    execSync(
      `docker run --rm -d --name ${container} ` +
      `-e POSTGRES_USER=${PG.user} -e POSTGRES_PASSWORD=${PG.pass} -e POSTGRES_DB=${PG.db} ` +
      `-p 127.0.0.1:${pgPort}:5432 postgres:16-alpine`,
      { stdio: "pipe" }
    );
    await waitForPostgres(container);

    const appPort = await freePort();
    // пустая БД -> сервер сам сеет пустую версию 1
    server = spawn("bin/firenet", [], {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        ...process.env,
        FIRENET_ADDR: `127.0.0.1:${appPort}`,
        FIRENET_DATABASE_URL: `postgres://${PG.user}:${PG.pass}@127.0.0.1:${pgPort}/${PG.db}?sslmode=disable`,
        FIRENET_ADMIN_USER: ADMIN.username,
        FIRENET_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: "inherit",
    });

    const baseURL = `http://127.0.0.1:${appPort}`;
    const ready = async () => {
      const res = await fetch(`${baseURL}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ADMIN),
      });
      return res.ok;
    };
    await waitFor("сервер firenet", ready, 60_000);
    // Успешный логин уже означает, что Postgres и миграции готовы; отдельной
    // проверки pg_isready не нужно.

    fs.writeFileSync(ENV_FILE, JSON.stringify({ baseURL, container, admin: ADMIN }));
    fs.writeFileSync(new URL("./.e2e-server.pid", import.meta.url), String(server.pid));
  } catch (error) {
    cleanupSetupResources(container, server);
    throw error;
  }
}
