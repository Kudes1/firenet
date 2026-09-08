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

// Порядок важен: сначала фронтенд, потом бэкенд. Если убить backend первым,
// Vite-прокси начнёт возвращать 502, но сам процесс останется висеть.
export function cleanupSetupResources(container, server, frontend) {
  for (const proc of [frontend, server]) {
    if (proc?.pid) {
      try { process.kill(proc.pid, "SIGTERM"); } catch { /* уже умер */ }
    }
  }
  if (container) {
    try { execSync(`docker rm -f ${container}`, { stdio: "pipe" }); } catch { /* уже удалён */ }
  }
}

export default async function globalSetup() {
  let container;
  let server;
  let frontend;
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
    // пустая БД -> сервер сам сеет версию 1 с дефолтной цепочкой правил
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

    const backendReady = async () => {
      const res = await fetch(`http://127.0.0.1:${appPort}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ADMIN),
      });
      return res.ok;
    };
    await waitFor("сервер firenet", backendReady, 60_000);
    // Успешный логин уже означает, что Postgres и миграции готовы; отдельной
    // проверки pg_isready не нужно.

    // Playwright ходит на Vite: он же отдаёт статику React-приложения и
    // проксирует /api на бэкенд — один origin, cookie-сессия работает.
    const fePort = await freePort();
    frontend = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(fePort), "--strictPort"], {
      cwd: new URL("../frontend", import.meta.url).pathname,
      env: {
        ...process.env,
        // Прокси Vite должен знать, где бэкенд: dev-режим вне compose.
        VITE_API_TARGET: `http://127.0.0.1:${appPort}`,
      },
      stdio: "inherit",
    });

    const baseURL = `http://127.0.0.1:${fePort}`;
    await waitFor("frontend", async () => {
      const res = await fetch(baseURL + "/");
      return res.ok;
    }, 60_000);

    fs.writeFileSync(ENV_FILE, JSON.stringify({ baseURL, container, admin: ADMIN }));
    fs.writeFileSync(new URL("./.e2e-server.pid", import.meta.url), String(server.pid));
    fs.writeFileSync(new URL("./.e2e-frontend.pid", import.meta.url), String(frontend.pid));
  } catch (error) {
    cleanupSetupResources(container, server, frontend);
    throw error;
  }
}
