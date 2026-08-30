import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const setup = await import("./global-setup.js");

test("cleanupSetupResources останавливает сервер и удаляет контейнер", async () => {
  assert.equal(typeof setup.cleanupSetupResources, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "firenet-e2e-"));
  const log = path.join(dir, "docker.log");
  const docker = path.join(dir, "docker");
  fs.writeFileSync(docker, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$E2E_DOCKER_LOG\"\n");
  fs.chmodSync(docker, 0o755);

  const oldPath = process.env.PATH;
  const oldLog = process.env.E2E_DOCKER_LOG;
  process.env.PATH = `${dir}:${oldPath}`;
  process.env.E2E_DOCKER_LOG = log;
  const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

  try {
    setup.cleanupSetupResources("firenet-e2e-pg-test", server);
    await once(server, "exit");
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["rm", "-f", "firenet-e2e-pg-test"]);
  } finally {
    process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.E2E_DOCKER_LOG;
    else process.env.E2E_DOCKER_LOG = oldLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
