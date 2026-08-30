import { execSync } from "node:child_process";
import fs from "node:fs";

const ENV_FILE = new URL("./.e2e-env.json", import.meta.url);

export default async function globalTeardown() {
  if (!fs.existsSync(ENV_FILE)) return;
  const { container } = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
  const pid = Number(fs.readFileSync(new URL("./.e2e-server.pid", import.meta.url), "utf8"));
  try { process.kill(pid, "SIGTERM"); } catch { /* уже умер */ }
  try { execSync(`docker rm -f ${container}`, { stdio: "pipe" }); } catch { /* уже удалён */ }
  fs.rmSync(ENV_FILE);
}
