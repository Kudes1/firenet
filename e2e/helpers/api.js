import fs from "node:fs";

export function env() {
  return JSON.parse(fs.readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8"));
}
