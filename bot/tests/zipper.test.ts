import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";

// The archive helper imports the shared configuration; no services are contacted.
for (const key of ["BOT_TOKEN", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "ALLOWED_USER_IDS",
  "QB_PASSWORD", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) {
  process.env[key] ||= "test";
}
const { create7zArchive } = await import("../src/pipeline/zipper.js");

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  const files = ["資料夾/同名.txt", "other/同名.txt", "-special @file.txt"].map((name) => {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, randomBytes(4096));
    return file;
  });
  return { root, source, output, files };
}

for (const [label, size] of [["single 7z", undefined], ["7z volumes", 0.002], ["single volume renamed 7z", 1]] as const) {
  test(`${label} preserves paths and bytes`, async (t) => {
    const { root, source, output, files } = fixture(t);
    const archives = await create7zArchive(files, "測試", source, output, size);
    if (size === 0.002) {
      assert.ok(archives.length > 1);
      assert.ok(archives[0].endsWith(".7z.001"));
      for (const archive of archives) assert.ok(fs.statSync(archive).size <= Math.floor(size * 1024 * 1024));
    } else {
      assert.equal(archives.length, 1);
      assert.ok(archives[0].endsWith(".7z"));
    }
    const { stdout } = await promisify(execFile)("7z", ["l", "-slt", archives[0]]);
    assert.match(stdout, /Type = 7z/);
    assert.match(stdout, /Method = LZMA2/);
    const extract = path.join(root, "extracted");
    await promisify(execFile)("7z", ["x", "-y", `-o${extract}`, archives[0]]);
    for (const file of files) {
      assert.deepEqual(fs.readFileSync(path.join(extract, path.relative(source, file))), fs.readFileSync(file));
    }
    assert.equal(fs.existsSync(path.join(output, "contents")), false);
  });
}

test("missing input fails instead of producing an incomplete 7z", async (t) => {
  const { source, output, files } = fixture(t);
  await assert.rejects(create7zArchive([...files, path.join(source, "missing")], "test", source, output));
  assert.deepEqual(fs.readdirSync(output), []);
});

test("empty input and invalid volume sizes are rejected", async (t) => {
  const { source, output, files } = fixture(t);
  await assert.rejects(create7zArchive([], "test", source, output));
  for (const size of [0, -1, NaN, Infinity]) {
    await assert.rejects(create7zArchive(files, "test", source, output, size));
  }
});

test("colliding names from outside the source root are rejected", async (t) => {
  const { source, output, files } = fixture(t);
  await assert.rejects(create7zArchive(files, "test", path.join(source, "unrelated"), output), /檔名重複/);
  assert.deepEqual(fs.readdirSync(output), []);
});
