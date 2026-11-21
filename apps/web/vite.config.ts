/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.PHOTO_CURATOR_WEB_HOST || "127.0.0.1";
const port = Number(process.env.PHOTO_CURATOR_WEB_PORT || 7100);
const apiPort = Number(process.env.PHOTO_CURATOR_API_PORT || 8765);

const config = {
  plugins: [react()],
  server: {
    host,
    port,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host,
    port,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    css: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
};

// `test` 由 Vitest 读取；Vite 的 UserConfig 不包含该字段，因此通过变量传递避免多余属性检查。
export default defineConfig(config);
