#!/usr/bin/env node
// Runs wrangler against one deployment's config, deployments/<name>.jsonc.
// deployments/ is ignored by this repository; keep it as a clone of your own
// private repository of deployment configs (README: 設定をリポジトリで管理する).
//
//   npm run deploy -- <name> [wrangler deploy options]
//   npm run secret -- <name> put <KEY>        (also list, delete)
//   npm run tail -- <name> [--format json]
//   npm run d1-migrate -- <name>             (the topic index's tables: wrangler d1 migrations apply MURMUR_DB --remote)
//   node tools/wrangler.mjs <wrangler command> <name> [options]
//
// There is no wrangler.jsonc at the root, so a bare `wrangler deploy` fails
// instead of picking a deployment by accident.
//
// Before a deploy, the plugins under plugins/ are zipped into dist/plugins.js, which the
// Worker bundles, so that the web UI offers the skills of the version it runs.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, "deployments");
const [command, name, ...rest] = process.argv.slice(2);
const names = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith(".jsonc"))
      .map((f) => f.slice(0, -".jsonc".length))
  : [];

if (!command || !name) {
  console.error(`usage: npm run ${command ?? "<deploy|secret|tail>"} -- <deployment> [options]`);
  console.error(names.length ? `deployments: ${names.join(", ")}` : "no deployments yet: git clone <your deployments repository> deployments, or create deployments/<name>.jsonc (see the deploy skill)");
  process.exit(2);
}
const config = join(dir, `${name}.jsonc`);
if (!existsSync(config)) {
  console.error(`no such deployment: ${relative(root, config)}`);
  if (names.length) console.error(`deployments: ${names.join(", ")}`);
  process.exit(2);
}

if (command === "deploy" || command === "versions") {
  const built = spawnSync("python3", ["tools/build-plugin-zip.py", "--bundle"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

// The topic index (docs/adr/0005) is bundled from topic-index/, which has its own dependencies.
if ((command === "deploy" || command === "versions") && !existsSync(join(root, "topic-index", "node_modules"))) {
  console.error("topic-index/node_modules is missing: run npm install at the repository root first");
  process.exit(2);
}

const args = command === "d1-migrate" ? ["d1", "migrations", "apply", "MURMUR_DB", "--remote", ...rest] : [command, ...rest];
const result = spawnSync("npx", ["wrangler", ...args, "--config", relative(root, config)], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
