#!/usr/bin/env node
/**
 * A7 —— 模板渲染器：把 fleet.yaml.tpl 里的 ENV_VAR 占位符（形如 ${ENV_VAR}）替换为环境变量。
 * 任一占位符缺失即失败退出（不静默产出残缺 fleet）。
 */
import { readFileSync, writeFileSync } from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error("usage: render-template <input> <output>");
  process.exit(2);
}

const raw = readFileSync(inputPath, "utf8");
const missing = new Set();
const rendered = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => {
  const value = process.env[name];
  if (value === undefined) {
    missing.add(name);
    return "";
  }
  return value;
});

if (missing.size > 0) {
  console.error(`render-template: missing env vars: ${[...missing].sort().join(", ")}`);
  process.exit(2);
}

if (/\$\{[A-Z0-9_]+\}/.test(rendered)) {
  console.error("render-template: unresolved placeholders remain after rendering");
  process.exit(2);
}

writeFileSync(outputPath, rendered, "utf8");
