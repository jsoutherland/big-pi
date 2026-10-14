import assert from "node:assert/strict";
import {
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, VERSION } from "../lib/big-pi.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function listFiles(directory, relative = "") {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const relativePath = relative ? `${relative}/${name}` : name;
    const absolutePath = path.join(directory, name);
    if (lstatSync(absolutePath).isDirectory()) files.push(...listFiles(absolutePath, relativePath));
    else files.push(relativePath.split(path.sep).join("/"));
  }
  return files.sort();
}

function stageRelease() {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "big-pi-release-"));
  const outputDirectory = path.join(temporaryDirectory, "dist");
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "release.js"), "--output", outputDirectory],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return {
    temporaryDirectory,
    directory: path.join(outputDirectory, `big-pi-${VERSION}`),
  };
}

function verify(directory) {
  return spawnSync(process.execPath, [path.join(directory, "verify-release.js")], {
    cwd: directory,
    encoding: "utf8",
  });
}

test("release contains only the installable runtime and user documentation", (t) => {
  const release = stageRelease();
  t.after(() => rmSync(release.temporaryDirectory, { recursive: true, force: true }));

  const files = listFiles(release.directory);
  const stagedPackage = JSON.parse(readFileSync(path.join(release.directory, "package.json"), "utf8"));
  const shippedLicense = readFileSync(path.join(release.directory, "LICENSE"), "utf8");
  const manifest = JSON.parse(readFileSync(path.join(release.directory, "RELEASE_MANIFEST.json"), "utf8"));
  const sums = readFileSync(path.join(release.directory, "SHA256SUMS"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.slice(line.indexOf("./") + 2));

  assert.equal(stagedPackage.name, "big-pi");
  assert.equal(stagedPackage.version, packageJson.version);
  assert.equal(packageJson.license, "Apache-2.0");
  assert.equal(stagedPackage.license, "Apache-2.0");
  assert.ok(files.includes("LICENSE"));
  assert.match(shippedLicense, /^\s*Apache License\s*\n\s*Version 2\.0,/);
  assert.equal(stagedPackage.license, packageJson.license);
  assert.deepEqual(stagedPackage.pi.extensions, ["./index.js"]);
  assert.equal(stagedPackage.dependencies, undefined);
  assert.equal(stagedPackage.scripts, undefined);
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes("START_HERE.md"));
  assert.ok(files.includes("index.js"));
  assert.ok(files.includes("lib/big-pi.js"));
  assert.ok(files.includes("docs/CONFIGURATION.md"));
  assert.ok(files.includes("docs/DIAGNOSTICS.md"));
  assert.ok(files.includes("docs/ARCHITECTURE.md"));
  assert.ok(files.includes("benchmarks/benchmark.mjs"));
  assert.ok(files.includes("benchmarks/compare.html"));
  assert.ok(files.includes("benchmarks/compare.html"));
  assert.ok(files.includes("benchmarks/README.md"));
  assert.ok(files.includes("benchmarks/examples/baseline-config.json"));
  assert.ok(files.includes("benchmarks/examples/prompts.json"));
  assert.ok(files.includes("benchmarks/examples/radar-equations-prompts.json"));
  assert.ok(files.includes("benchmarks/examples/radar-equations-prompts-verbose.json"));
  assert.ok(files.includes("benchmarks/config-sets/80k-context.json"));
  assert.ok(files.includes("verify-release.js"));
  assert.ok(files.includes("RELEASE_MANIFEST.json"));
  assert.ok(files.includes("SHA256SUMS"));
  assert.ok(!files.includes("TASK.md"));
  assert.ok(!files.includes("AGENTS.md"));
  assert.ok(!files.some((file) => file.startsWith("test/") || file.includes("node_modules")));
  assert.ok(!files.some((file) => file.startsWith(".git/") || file.startsWith("scripts/")));
  assert.deepEqual(manifest.runtimeDependencies, []);
  assert.equal(manifest.storageManifestSchemaVersion, SCHEMA_VERSION);
  assert.deepEqual(manifest.files.map((entry) => entry.path), [...manifest.files.map((entry) => entry.path)].sort());
  assert.deepEqual(sums, [...sums].sort());
  assert.ok(!sums.includes("SHA256SUMS"));
  assert.ok(sums.includes("RELEASE_MANIFEST.json"));
  assert.ok(manifest.files.some((entry) => entry.path === "verify-release.js"));
  assert.equal(verify(release.directory).status, 0);
});

test("release verifier detects modified files", (t) => {
  const release = stageRelease();
  t.after(() => rmSync(release.temporaryDirectory, { recursive: true, force: true }));
  const target = path.join(release.directory, "lib", "big-pi.js");
  writeFileSync(target, `${readFileSync(target, "utf8")}\n// tampered\n`);
  const result = verify(release.directory);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /hash mismatch: lib\/big-pi\.js/);
});

test("release verifier detects missing files", (t) => {
  const release = stageRelease();
  t.after(() => rmSync(release.temporaryDirectory, { recursive: true, force: true }));
  unlinkSync(path.join(release.directory, "README.md"));
  const result = verify(release.directory);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /missing: README\.md/);
});

test("identical source inputs produce identical staged files and hashes", (t) => {
  const first = stageRelease();
  const second = stageRelease();
  t.after(() => {
    rmSync(first.temporaryDirectory, { recursive: true, force: true });
    rmSync(second.temporaryDirectory, { recursive: true, force: true });
  });
  const firstFiles = listFiles(first.directory);
  const secondFiles = listFiles(second.directory);
  assert.deepEqual(firstFiles, secondFiles);
  for (const relativePath of firstFiles) {
    assert.deepEqual(
      readFileSync(path.join(first.directory, relativePath)),
      readFileSync(path.join(second.directory, relativePath)),
      `${relativePath} differs between stages`,
    );
  }
});

test("package and runtime release versions stay synchronized", () => {
  assert.equal(packageJson.version, VERSION);
});
