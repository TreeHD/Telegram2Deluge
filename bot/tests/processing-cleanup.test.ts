import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const key of ["BOT_TOKEN", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "ALLOWED_USER_IDS",
  "QB_PASSWORD", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) {
  process.env[key] ||= "test";
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "processing-cleanup-test-"));
const downloads = path.join(root, "downloads");
const processing = path.join(root, "processing");
const queue = path.join(root, "queue");
for (const directory of [downloads, processing, queue]) fs.mkdirSync(directory);
process.env.DOWNLOAD_DIR = downloads;
process.env.PROCESSING_DIR = processing;
process.env.QUEUE_DIR = queue;
process.env.PROCESSING_CLEANUP_DELAY_MINUTES = "0.002";

const { clearProcessingOnStartup } = await import("../src/cleanup/index.js");
const { Pipeline } = await import("../src/pipeline/index.js");
const { addPendingAction, addPipelineJob, getNextPendingJob, getPendingAction, db } =
  await import("../src/db/index.js");
after(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup empties processing, preserves downloads and requeues dependent actions", () => {
  const original = path.join(downloads, "movie.mkv");
  const mux = path.join(processing, "movie.mkv");
  fs.writeFileSync(original, "original");
  fs.writeFileSync(mux, "temporary mux");
  const abandoned = path.join(processing, "telegram-old");
  fs.mkdirSync(abandoned);
  fs.writeFileSync(path.join(abandoned, "part001"), "stale");

  addPipelineJob({
    id: "cleanup-test-job", torrentId: "abc", chatId: 123, messageId: 1,
    name: "movie", savePath: downloads, files: [{ path: "movie.mkv", size: 8 }],
    totalSize: 8, status: "done",
  });
  addPendingAction("cleanup-test-job", 123, [mux, original], original);
  clearProcessingOnStartup();

  assert.deepEqual(fs.readdirSync(processing), []);
  assert.equal(fs.readFileSync(original, "utf8"), "original");
  assert.equal(getPendingAction("cleanup-test-job"), undefined);
  assert.equal(getNextPendingJob()?.id, "cleanup-test-job");
});

test("upload cleanup waits for delay and does not touch original or pending mux files", async () => {
  const original = path.join(downloads, "keep.mkv");
  const mux = path.join(processing, "pending.mkv");
  fs.writeFileSync(original, "original");
  fs.writeFileSync(mux, "pending");
  const dirs = ["telegram-", "archive-", "playlist-"].map((prefix) =>
    fs.mkdtempSync(path.join(processing, prefix)));
  const temps = dirs.map((directory) => {
    const file = path.join(directory, "part");
    fs.writeFileSync(file, "temporary");
    return file;
  });

  Pipeline.prototype.scheduleProcessingCleanup([...temps, original, mux]);
  for (const directory of dirs) assert.equal(fs.existsSync(directory), true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const directory of dirs) assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.readFileSync(original, "utf8"), "original");
  assert.equal(fs.readFileSync(mux, "utf8"), "pending");
});
