import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Конфиг один на Vite и на Vitest: defineConfig из vitest/config принимает и
// server.*, и test.*, поэтому отдельный vitest.config.ts не нужен.
// Таргет прокси читается из переменной процесса VITE_API_TARGET (задаётся ENV
// в dev-стейдже frontend/Dockerfile и в e2e/global-setup.js): process.env имеет
// высший приоритет над .env-файлами, поэтому loadEnv с пустым префиксом не
// нужен — а в Vite 5.4 он и запрещён (resolveEnvPrefix бросает исключение на
// пустой префикс). Файла .env в контейнере нет.
const apiTarget = process.env.VITE_API_TARGET ?? "http://backend:8787";

export default defineConfig(() => ({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Vite dev-сервер — единственная точка входа в dev: /api уходит в
      // backend-контейнер, всё остальное отдаётся React-приложением. Один
      // origin на клиенте — cookie-сессия работает без CORS.
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
}));
