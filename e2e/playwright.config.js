import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scenarios",
  globalSetup: "./global-setup.js",
  globalTeardown: "./global-teardown.js",
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
});
