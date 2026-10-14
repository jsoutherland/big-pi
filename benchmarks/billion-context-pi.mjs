import { readFile, stat } from "node:fs/promises";

const emptyTiers = () => ({ "1": 0, "2": 0, "3": 0 });
const unavailable = (manifestStatus, sidecarPresent = true, detected = false) => ({
  detected, sidecarPresent, manifestStatus, totalBlocks: null, blocksByTier: null,
});

export async function readBillionContextPiSummary(sessionFile) {
  if (!sessionFile) return { detected: false, sidecarPresent: false, manifestStatus: "absent", totalBlocks: 0, blocksByTier: emptyTiers() };
  const sidecarPath = `${sessionFile}.acp.json`;
  let contents;
  try {
    const info = await stat(sidecarPath);
    if (!info.isFile()) return unavailable("unreadable");
    contents = await readFile(sidecarPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { detected: false, sidecarPresent: false, manifestStatus: "absent", totalBlocks: 0, blocksByTier: emptyTiers() };
    return unavailable("unreadable");
  }
  let sidecar;
  try { sidecar = JSON.parse(contents); }
  catch { return unavailable("malformed"); }
  if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) return unavailable("malformed");
  if (typeof sidecar.producer !== "string" || !sidecar.producer.startsWith("billion-context-pi@")) return unavailable("foreign");
  if (sidecar.schemaVersion !== undefined && !Number.isInteger(sidecar.schemaVersion)) return unavailable("malformed", true, true);
  if (sidecar.schemaVersion !== undefined && sidecar.schemaVersion !== 1) return unavailable("unsupported", true, true);
  if (!Array.isArray(sidecar.blocks)) return unavailable("malformed", true, true);
  const blocksByTier = emptyTiers();
  const seen = new Set();
  for (const block of sidecar.blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block) || typeof block.blockId !== "string" || !/^b\d+$/.test(block.blockId) || seen.has(block.blockId) || ![1, 2, 3].includes(block.tier)) {
      return unavailable("malformed", true, true);
    }
    seen.add(block.blockId);
    blocksByTier[String(block.tier)]++;
  }
  return { detected: true, sidecarPresent: true, manifestStatus: "valid", totalBlocks: Object.values(blocksByTier).reduce((sum, n) => sum + n, 0), blocksByTier };
}
