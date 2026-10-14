import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(root, ".terax-package-state.json");
const inputPaths = [
  "src",
  "src-tauri",
  "scripts",
  "index.html",
  "settings.html",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vite.web.config.ts",
  "public",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/build.rs",
  "src-tauri/tauri.conf.json",
];

const manifestPaths = {
  package: resolve(root, "package.json"),
  cargo: resolve(root, "src-tauri/Cargo.toml"),
  tauri: resolve(root, "src-tauri/tauri.conf.json"),
  cargoLock: resolve(root, "src-tauri/Cargo.lock"),
};

const workspacePackageNames = ["awei-work"];

function readText(path) {
  return readFileSync(path, "utf8");
}

function writeText(path, content) {
  writeFileSync(path, content, "utf8");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readVersion() {
  const packageVersion = JSON.parse(readText(manifestPaths.package)).version;
  const tauriVersion = JSON.parse(readText(manifestPaths.tauri)).version;
  const cargoVersions = [...readText(manifestPaths.cargo).matchAll(
    /^version = "([^"]+)"$/gm,
  )].map((match) => match[1]);
  const lockVersions = workspaceLockVersions(readText(manifestPaths.cargoLock));
  if (
    typeof packageVersion !== "string" ||
    typeof tauriVersion !== "string" ||
    cargoVersions.length !== 1 ||
    tauriVersion !== packageVersion ||
    cargoVersions.some((version) => version !== packageVersion) ||
    lockVersions.some((version) => version !== packageVersion)
  ) {
    throw new Error(
      "awei-work version must match in package.json, Cargo.toml, Cargo.lock, and tauri.conf.json.",
    );
  }
  return packageVersion;
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Cannot increment non-semver version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function replaceJsonVersion(content, version) {
  const replaced = content.replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${version}$2`,
  );
  if (replaced === content) throw new Error("Could not update manifest version.");
  return replaced;
}

function updateVersion(version) {
  const originals = Object.fromEntries(
    Object.entries(manifestPaths).map(([name, path]) => [name, readText(path)]),
  );
  const current = readVersionFromCargo(originals.cargo);
  const line = new RegExp(`^version = "${escapeRegex(current)}"$`, "gm");
  const cargo = originals.cargo.replace(line, `version = "${version}"`);
  if ((cargo.match(/^version = "/gm) ?? []).length !== 1) {
    throw new Error("Could not update Cargo package version.");
  }
  const updated = {
    package: replaceJsonVersion(originals.package, version),
    tauri: replaceJsonVersion(originals.tauri, version),
    cargo,
    cargoLock: replaceWorkspaceLockVersions(originals.cargoLock, version),
  };
  try {
    for (const [name, content] of Object.entries(updated)) writeText(manifestPaths[name], content);
  } catch (error) {
    for (const [name, content] of Object.entries(originals)) writeText(manifestPaths[name], content);
    throw error;
  }
  return originals;
}

function workspaceLockVersions(content) {
  return workspacePackageNames.map((name) => {
    const match = new RegExp(
      `name = "${escapeRegex(name)}"\\r?\\nversion = "([^"]+)"`,
    ).exec(content);
    if (!match) throw new Error(`Could not find ${name} in Cargo.lock.`);
    return match[1];
  });
}

function replaceWorkspaceLockVersions(content, version) {
  let next = content;
  for (const name of workspacePackageNames) {
    const pattern = new RegExp(
      `(name = "${escapeRegex(name)}"\\r?\\nversion = ")[^"]+(")`,
    );
    const replaced = next.replace(pattern, `$1${version}$2`);
    if (replaced === next) {
      throw new Error(`Could not update ${name} in Cargo.lock.`);
    }
    next = replaced;
  }
  return next;
}

function readVersionFromCargo(content) {
  const versions = [...content.matchAll(/^version = "([^"]+)"$/gm)].map(
    (match) => match[1],
  );
  if (versions.length !== 1) {
    throw new Error("Expected one Cargo package version.");
  }
  return versions[0];
}

function inputFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...inputPaths],
    { cwd: root, encoding: "utf8" },
  );
  const files = output.split("\0").filter((path) =>
    path && path !== "src-tauri/web.html" && existsSync(resolve(root, path)),
  );
  return [...new Set(files)].sort();
}

function normalizedContent(relativePath, content, version) {
  if (
    relativePath === "package.json" ||
    relativePath === "src-tauri/tauri.conf.json"
  ) {
    return content.replace(
      /("version"\s*:\s*")[^"]+(")/,
      "$1__TERAX_VERSION__$2",
    );
  }
  if (relativePath === "src-tauri/Cargo.toml") {
    const line = new RegExp(`^version = "${escapeRegex(version)}"$`, "gm");
    return content.replace(line, 'version = "__TERAX_VERSION__"');
  }
  if (relativePath === "src-tauri/Cargo.lock") {
    return replaceWorkspaceLockVersions(content, "__TERAX_VERSION__");
  }
  return content;
}

function sourceFingerprint(version) {
  const hash = createHash("sha256");
  for (const relativePath of inputFiles()) {
    const path = resolve(root, relativePath);
    hash.update(relativePath);
    hash.update("\0");
    if (!existsSync(path)) {
      hash.update("<missing>");
      hash.update("\0");
      continue;
    }
    const content = readFileSync(path);
    const normalized = Object.values(manifestPaths).includes(path)
      ? normalizedContent(relativePath, content.toString("utf8"), version)
      : content;
    hash.update(normalized);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readState() {
  if (!existsSync(statePath)) return null;
  try {
    const state = JSON.parse(readText(statePath));
    return typeof state?.fingerprint === "string" ? state : null;
  } catch {
    return null;
  }
}

function writeState(version) {
  const fingerprint = sourceFingerprint(version);
  writeText(
    statePath,
    `${JSON.stringify({ version, fingerprint }, null, 2)}\n`,
  );
}

export function preparePackageVersion() {
  const version = readVersion();
  if (process.env.GITHUB_REF_TYPE === "tag") {
    if (process.env.GITHUB_REF_NAME !== `v${version}`) {
      throw new Error("Release tag must match the manifest version.");
    }
    return { changed: false, version, originals: null };
  }
  const changed = readState()?.fingerprint !== sourceFingerprint(version);
  if (!changed) return { changed: false, version, originals: null };
  const next = nextPatch(version);
  return { changed: true, version: next, originals: updateVersion(next) };
}

export function finalizePackageVersion(transaction) {
  writeState(transaction.version);
}

export function rollbackPackageVersion(transaction) {
  if (!transaction.changed || !transaction.originals) return;
  for (const [name, content] of Object.entries(transaction.originals)) {
    writeText(manifestPaths[name], content);
  }
}
