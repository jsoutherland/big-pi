import assert from "node:assert/strict";
import test from "node:test";
import { appendWithRetry, createAppendQueue } from "../benchmarks/io.mjs";

test("temporary Windows open locks retry without reordering records", async () => {
  let attempts = 0;
  const records = [];
  const pauses = [];
  const queue = createAppendQueue({
    write: async (_file, text) => {
      if (++attempts <= 2) throw Object.assign(new Error("locked"), { code: "EBUSY", syscall: "open" });
      records.push(text);
    },
    pause: async (ms) => { pauses.push(ms); },
  });
  queue.append("events", "first");
  queue.append("events", "second");
  await queue.flush();
  assert.deepEqual(records, ["first", "second"]);
  assert.deepEqual(pauses, [50, 100]);
});

test("permanent locks are bounded and reported by flush", async () => {
  let attempts = 0;
  const error = Object.assign(new Error("locked"), { code: "EBUSY", syscall: "open" });
  const queue = createAppendQueue({ write: async () => { attempts++; throw error; }, pause: async () => {} });
  queue.append("events", "first");
  queue.append("events", "second");
  await assert.rejects(queue.flush(), (caught) => caught === error);
  assert.equal(attempts, 7);
});

test("failed writes are not replayed because bytes might already be appended", async () => {
  let attempts = 0;
  await assert.rejects(appendWithRetry("events", "record", {
    write: async () => { attempts++; throw Object.assign(new Error("partial write"), { code: "EBUSY", syscall: "write" }); },
  }));
  assert.equal(attempts, 1);
});
