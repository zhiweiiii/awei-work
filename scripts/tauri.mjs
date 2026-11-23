import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceReleaseVersion,
  finalizePackageVersion,
  preparePackageVersion,
  rollbackPackageVersion,
} from "./packageVersion.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const tauriCli = resolve(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

if (args.length === 1 && args[0] === "release-version") {
  console.log(`awei-work release version: v${advanceReleaseVersion()}`);
  process.exit(0);
}

function runTauri() {
  const result = spawnSync(process.execPath, [tauriCli, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error);
    return 1;
  }
  return result.status ?? 1;
}

if (args[0] !== "build") {
  process.exit(runTauri());
}

const transaction = preparePackageVersion();
if (transaction.changed) {
  console.log(`awei-work package version: v${transaction.version}`);
}

const status = runTauri();
if (status === 0) {
  finalizePackageVersion(transaction);
  process.exit(0);
}

rollbackPackageVersion(transaction);
process.exit(status);
