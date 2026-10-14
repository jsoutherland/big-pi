import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function appendWithRetry(file, text, { write = writeFile, pause = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await write(file, text, { flag: "a" });
      return;
    } catch (error) {
      // Retry only failures to open: a failed write may already have appended bytes.
      if (!["EBUSY", "EACCES", "EPERM"].includes(error.code) || error.syscall !== "open" || attempt >= 6) throw error;
      await pause(Math.min(50 * 2 ** attempt, 1000));
    }
  }
}

export function createAppendQueue(options) {
  const tails = new Map();
  let failure;
  return {
    append(file, text) {
      const next = (tails.get(file) ?? Promise.resolve()).then(async () => {
        if (!failure) await appendWithRetry(file, text, options);
      }).catch((error) => { failure ??= error; });
      tails.set(file, next);
    },
    async flush() {
      await Promise.all(tails.values());
      if (failure) throw failure;
    },
  };
}
