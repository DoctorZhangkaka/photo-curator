#!/usr/bin/env node
/**
 * 同时启动 FastAPI（默认 127.0.0.1:8765）与 Vite（默认 127.0.0.1:7100）。
 *
 * 用法：npm run dev -- [--host 127.0.0.1] [--port 7100] [--api-port 8765]
 * CLI 的 host/port 会转发给 Vite，并同步给后端用于 Origin 白名单。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function valueOf(flag, fallback) {
  const index = args.indexOf(flag);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.split("=")[1];
  return fallback;
}

const host = valueOf("--host", process.env.PHOTO_CURATOR_WEB_HOST || "127.0.0.1");
const port = valueOf("--port", process.env.PHOTO_CURATOR_WEB_PORT || "7100");
const apiHost = valueOf("--api-host", process.env.PHOTO_CURATOR_HOST || "127.0.0.1");
const apiPort = valueOf("--api-port", process.env.PHOTO_CURATOR_PORT || "8765");

const python = path.join(root, ".venv", "bin", "python");
if (!existsSync(python)) {
  console.error("未找到 .venv，请先运行：npm run setup");
  process.exit(1);
}
const vite = path.join(root, "node_modules", ".bin", "vite");
if (!existsSync(vite)) {
  console.error("未找到前端依赖，请先运行：npm install");
  process.exit(1);
}

const baseEnv = {
  ...process.env,
  PHOTO_CURATOR_HOST: apiHost,
  PHOTO_CURATOR_PORT: apiPort,
  PHOTO_CURATOR_WEB_HOST: host,
  PHOTO_CURATOR_WEB_PORT: port,
  PHOTO_CURATOR_API_PORT: apiPort,
};

const children = [];
let shuttingDown = false;

function launch(name, command, commandArgs, options) {
  const child = spawn(command, commandArgs, { ...options, env: baseEnv, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} 已退出（code=${code}, signal=${signal}），正在停止其余进程…`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
    process.exit(code);
  }, 1500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`[dev] API  http://${apiHost}:${apiPort}`);
console.log(`[dev] Web  http://${host}:${port}`);

launch(
  "api",
  python,
  ["-m", "uvicorn", "photo_curator.main:app", "--host", apiHost, "--port", apiPort],
  { cwd: root },
);
launch("web", vite, ["--host", host, "--port", port], {
  cwd: path.join(root, "apps", "web"),
});
