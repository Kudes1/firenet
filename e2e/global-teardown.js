import { execSync } from "node:child_process";
import fs from "node:fs";

const ENV_FILE = new URL("./.e2e-env.json", import.meta.url);

export default async function globalTeardown() {
  if (!fs.existsSync(ENV_FILE)) return;
  const { container } = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
  for (const file of ["./.e2e-server.pid", "./.e2e-frontend.pid"]) {
    const pidFile = new URL(file, import.meta.url);
    if (!fs.existsSync(pidFile)) continue;
    try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* уже умер */ }
    fs.rmSync(pidFile);
  }
  try { execSync(`docker rm -f ${container}`, { stdio: "pipe" }); } catch { /* уже удалён */ }
  fs.rmSync(ENV_FILE);
}
