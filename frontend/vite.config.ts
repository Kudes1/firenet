import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Vite dev-сервер — единственная точка входа в dev: /api уходит в
      // backend-контейнер, всё остальное отдаётся React-приложением.
      "/api": { target: "http://backend:8787", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
