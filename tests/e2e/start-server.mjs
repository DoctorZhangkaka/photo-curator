#!/usr/bin/env node
/**
 * E2E 专用启动器：构造临时照片库、构建前端、以同源生产模式启动后端。
 * 所有数据位于 tests/.tmp，绝不接触真实相册。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const python = path.join(root, ".venv", "bin", "python");
const tmp = path.join(root, "tests", ".tmp");
const photoRoot = path.join(tmp, "e2e-photos");
const dataDir = path.join(tmp, "e2e-data");
const port = process.env.E2E_PORT || "8799";

if (!existsSync(python)) {
  console.error("缺少 .venv，请先运行 npm run setup");
  process.exit(1);
}

rmSync(photoRoot, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });

console.log("[e2e] 生成临时相册…");
const fixtures = spawnSync(
  python,
  [path.join(root, "scripts", "create-fixtures.py"), "--root", photoRoot, "--clean"],
  { cwd: root, stdio: "inherit" },
);
if (fixtures.status !== 0) process.exit(fixtures.status ?? 1);

console.log("[e2e] 构建前端…");
const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const env = {
  ...process.env,
  PHOTO_CURATOR_ROOT: photoRoot,
  PHOTO_CURATOR_DATA_DIR: dataDir,
  PHOTO_CURATOR_HOST: "127.0.0.1",
  PHOTO_CURATOR_PORT: port,
  PHOTO_CURATOR_WEB_HOST: "127.0.0.1",
  PHOTO_CURATOR_WEB_PORT: port,
  PHOTO_CURATOR_STARTUP_SCAN: "1",
  PHOTO_CURATOR_SERVE_STATIC: "1",
  PHOTO_CURATOR_ALLOWED_HOSTS: "127.0.0.1,localhost",
  PHOTO_CURATOR_THUMBNAIL_EDGE: "384",
  PHOTO_CURATOR_PREVIEW_EDGE: "1600",
};

console.log(`[e2e] 启动后端 http://127.0.0.1:${port}`);
const server = spawn(
  python,
  ["-m", "uvicorn", "photo_curator.main:app", "--host", "127.0.0.1", "--port", port],
  { cwd: root, env, stdio: "inherit" },
);

function shutdown(signal = "SIGTERM") {
  if (server.exitCode === null) server.kill(signal);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
server.on("exit", (code) => process.exit(code ?? 0));
