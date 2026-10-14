import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const errors = [];
const ignoredMetadata = new Set([".DS_Store", "Thumbs.db"]);

function fail(message) {
  errors.push(message);
  console.error(`FAIL: ${message}`);
}

function safeFilePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`invalid relative path ${JSON.stringify(relativePath)}`);
  }
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes release root: ${relativePath}`);
  }
  return absolutePath;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function walkFiles(directory, relative = "") {
  const found = [];
  for (const name of readdirSync(directory).sort()) {
    if (ignoredMetadata.has(name) || name === "__MACOSX") continue;
    const relativePath = relative ? `${relative}/${name}` : name;
    const absolutePath = path.join(directory, name);
    const info = lstatSync(absolutePath);
    if (info.isDirectory()) found.push(...walkFiles(absolutePath, relativePath));
    else if (info.isFile()) found.push(relativePath.split(path.sep).join("/"));
    else fail(`unexpected non-regular file: ${relativePath}`);
  }
  return found.sort();
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(path.join(root, "RELEASE_MANIFEST.json"), "utf8"));
} catch (error) {
  fail(`cannot read RELEASE_MANIFEST.json: ${error.message}`);
}

let sums = [];
try {
  const contents = readFileSync(path.join(root, "SHA256SUMS"), "utf8");
  const lines = contents.split(/\r?\n/).filter(Boolean);
  sums = lines.map((line) => {
    const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line);
    if (!match) throw new Error(`malformed SHA256SUMS line: ${line}`);
    return { sha256: match[1], path: match[2] };
  });
  const sortedPaths = sums.map((entry) => entry.path).sort();
  if (JSON.stringify(sums.map((entry) => entry.path)) !== JSON.stringify(sortedPaths)) {
    fail("SHA256SUMS entries are not sorted");
  }
  if (new Set(sums.map((entry) => entry.path)).size !== sums.length) {
    fail("SHA256SUMS contains duplicate paths");
  }
} catch (error) {
  fail(`cannot parse SHA256SUMS: ${error.message}`);
}

if (manifest) {
  if (manifest.product !== "big-pi" || typeof manifest.version !== "string") {
    fail("RELEASE_MANIFEST.json has invalid product/version metadata");
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    fail("RELEASE_MANIFEST.json has an unsupported schema or invalid files list");
  } else {
    const manifestPaths = [];
    for (const entry of manifest.files) {
      try {
        if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
          throw new Error("invalid hash or size");
        }
        const absolutePath = safeFilePath(entry.path);
        manifestPaths.push(entry.path);
        let info;
        try {
          info = lstatSync(absolutePath);
        } catch {
          fail(`missing: ${entry.path}`);
          continue;
        }
        if (!info.isFile()) {
          fail(`not a regular file: ${entry.path}`);
          continue;
        }
        const actualHash = sha256(absolutePath);
        if (actualHash !== entry.sha256) fail(`hash mismatch: ${entry.path}`);
        if (info.size !== entry.sizeBytes) fail(`size mismatch: ${entry.path}`);
      } catch (error) {
        fail(`invalid manifest file entry: ${error.message}`);
      }
    }
    const sortedPaths = [...manifestPaths].sort();
    if (JSON.stringify(manifestPaths) !== JSON.stringify(sortedPaths)) {
      fail("RELEASE_MANIFEST.json files are not sorted by path");
    }
    if (new Set(manifestPaths).size !== manifestPaths.length) {
      fail("RELEASE_MANIFEST.json contains duplicate paths");
    }

    const expectedSumPaths = [...manifestPaths, "RELEASE_MANIFEST.json"].sort();
    if (JSON.stringify(sums.map((entry) => entry.path)) !== JSON.stringify(expectedSumPaths)) {
      fail("SHA256SUMS must cover each manifest payload file and RELEASE_MANIFEST.json exactly");
    }
  }
}

for (const entry of sums) {
  try {
    const absolutePath = safeFilePath(entry.path);
    let info;
    try {
      info = lstatSync(absolutePath);
    } catch {
      fail(`missing: ${entry.path}`);
      continue;
    }
    if (!info.isFile()) {
      fail(`not a regular file: ${entry.path}`);
      continue;
    }
    if (sha256(absolutePath) !== entry.sha256) fail(`hash mismatch: ${entry.path}`);
  } catch (error) {
    fail(`invalid checksum entry: ${error.message}`);
  }
}

try {
  const actualFiles = walkFiles(root);
  const expectedFiles = new Set([...sums.map((entry) => entry.path), "SHA256SUMS"]);
  for (const file of actualFiles) {
    if (!expectedFiles.has(file)) fail(`unexpected file: ${file}`);
  }
  for (const file of expectedFiles) {
    if (!actualFiles.includes(file)) fail(`missing: ${file}`);
  }
} catch (error) {
  fail(`cannot inspect release files: ${error.message}`);
}

if (errors.length) {
  console.error(`Release verification failed (${errors.length} issue${errors.length === 1 ? "" : "s"}).`);
  process.exitCode = 1;
} else {
  console.log(`OK: verified ${manifest.files.length} payload files and RELEASE_MANIFEST.json.`);
}
