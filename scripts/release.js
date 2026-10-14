import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, SCHEMA_VERSION } from "../lib/big-pi.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let outputDirectory = path.join(root, "dist");
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--output" && args[index + 1]) {
    outputDirectory = path.resolve(args[++index]);
  } else {
    throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
}

const sourcePackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (sourcePackage.name !== "big-pi" || sourcePackage.version !== VERSION) {
  throw new Error("package.json name/version must match the runtime extension");
}
if (sourcePackage.private || Object.keys(sourcePackage.dependencies ?? {}).length > 0) {
  throw new Error("Release package must be public-installable with zero runtime dependencies");
}
if (JSON.stringify(sourcePackage.pi?.extensions) !== JSON.stringify(["./index.js"])) {
  throw new Error('Pi package must declare pi.extensions as ["./index.js"]');
}

const packageName = `big-pi-${VERSION}`;
const releaseDirectory = path.join(outputDirectory, packageName);
rmSync(releaseDirectory, { recursive: true, force: true });
mkdirSync(releaseDirectory, { recursive: true });

const approvedFiles = [
  "README.md",
  "START_HERE.md",
  "LICENSE",
  "index.js",
];

function copyFile(sourceRelativePath, releaseRelativePath = sourceRelativePath) {
  const source = path.join(root, sourceRelativePath);
  const destination = path.join(releaseDirectory, releaseRelativePath);
  if (!statSync(source).isFile()) throw new Error(`Expected a regular source file: ${sourceRelativePath}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function copyDirectory(relativeDirectory, javascriptOnly = false) {
  const sourceDirectory = path.join(root, relativeDirectory);
  for (const entry of readdirSync(sourceDirectory).sort()) {
    const relativePath = path.posix.join(relativeDirectory, entry);
    const sourcePath = path.join(root, relativePath);
    if (statSync(sourcePath).isDirectory()) copyDirectory(relativePath, javascriptOnly);
    else if (statSync(sourcePath).isFile() && (!javascriptOnly || entry.endsWith(".js"))) copyFile(relativePath);
  }
}

for (const file of approvedFiles) copyFile(file);
copyFile("scripts/verify-release.js", "verify-release.js");
copyDirectory("docs");
copyDirectory("lib", true);
copyDirectory("benchmarks");

const releasePackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  type: sourcePackage.type,
  description: sourcePackage.description,
  license: sourcePackage.license,
  keywords: sourcePackage.keywords,
  pi: sourcePackage.pi,
};
writeFileSync(
  path.join(releaseDirectory, "package.json"),
  `${JSON.stringify(releasePackage, null, 2)}\n`,
);

function listFiles(directory, relative = "") {
  const result = [];
  for (const entry of readdirSync(directory).sort()) {
    const relativePath = relative ? `${relative}/${entry}` : entry;
    const absolutePath = path.join(directory, entry);
    const info = statSync(absolutePath);
    if (info.isDirectory()) result.push(...listFiles(absolutePath, relativePath));
    else if (info.isFile()) result.push(relativePath.split(path.sep).join("/"));
  }
  return result.sort();
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const payloadFiles = listFiles(releaseDirectory).sort();
const manifest = {
  product: "big-pi",
  version: VERSION,
  schemaVersion: 1,
  runtimeDependencies: [],
  storageManifestSchemaVersion: SCHEMA_VERSION,
  piPackage: "Local package directory; package.json pi.extensions points to ./index.js",
  files: payloadFiles.map((relativePath) => ({
    path: relativePath,
    sha256: sha256(path.join(releaseDirectory, relativePath)),
    sizeBytes: statSync(path.join(releaseDirectory, relativePath)).size,
  })),
};
writeFileSync(
  path.join(releaseDirectory, "RELEASE_MANIFEST.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const sumFiles = [...payloadFiles, "RELEASE_MANIFEST.json"].sort();
const checksums = sumFiles.map((relativePath) =>
  `${sha256(path.join(releaseDirectory, relativePath))}  ./${relativePath}`,
).join("\n");
writeFileSync(path.join(releaseDirectory, "SHA256SUMS"), `${checksums}\n`);

const verify = process.execPath;
const verification = spawnSync(verify, ["verify-release.js"], {
  cwd: releaseDirectory,
  encoding: "utf8",
});
if (verification.status !== 0) {
  process.stderr.write(verification.stdout ?? "");
  process.stderr.write(verification.stderr ?? "");
  throw new Error("Staged package verification failed");
}

console.log(`Staged and verified ${packageName} at ${releaseDirectory}`);
