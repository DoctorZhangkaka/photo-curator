#!/usr/bin/env node
/** 一次安装 Python 与前端依赖。仅用于本地开发。 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = path.join(root, ".venv", "bin", "python");
const uv = process.env.UV_BIN || "uv";

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root, ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(python)) {
  run(uv, ["venv", "--python", "3.12", ".venv"]);
}
run(uv, ["pip", "install", "-p", ".venv", "-e", ".[dev]"]);
run("npm", ["install"]);
console.log("\n安装完成。启动开发环境：npm run dev");
