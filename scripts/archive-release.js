import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../lib/big-pi.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist");
const packageName = `big-pi-${VERSION}`;
const releaseDirectory = path.join(outputDirectory, packageName);
const archiveName = `${packageName}.zip`;
const archivePath = path.join(outputDirectory, archiveName);
const checksumPath = `${archivePath}.sha256`;

function listFiles(directory, relative = "") {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const relativePath = relative ? `${relative}/${name}` : name;
    const absolutePath = path.join(directory, name);
    const info = lstatSync(absolutePath);
    if (info.isDirectory()) files.push(...listFiles(absolutePath, relativePath));
    else if (info.isFile()) files.push(relativePath.split(path.sep).join("/"));
    else throw new Error(`Cannot archive non-regular file: ${relativePath}`);
  }
  return files.sort();
}

const files = listFiles(releaseDirectory);
if (!files.length) throw new Error(`Release directory is empty: ${releaseDirectory}`);
rmSync(archivePath, { force: true });
rmSync(checksumPath, { force: true });

const archive = spawnSync(
  "zip",
  ["-X", "-q", archiveName, ...files.map((file) => `${packageName}/${file}`)],
  { cwd: outputDirectory, encoding: "utf8" },
);
if (archive.error?.code === "ENOENT") {
  throw new Error("Optional ZIP creation requires the system 'zip' utility");
}
if (archive.status !== 0) {
  process.stderr.write(archive.stderr ?? "");
  throw new Error("ZIP archive creation failed");
}

const hash = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
writeFileSync(checksumPath, `${hash}  ${archiveName}\n`);
console.log(`Created ${archivePath}`);
console.log(`SHA-256: ${hash} (${checksumPath})`);
