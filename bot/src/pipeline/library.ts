import path from "node:path";
import fs from "node:fs";
import checkDiskSpace from "check-disk-space";
import { config, logger } from "../config.js";
import { getPendingAction } from "../db/index.js";

const LIBRARY_EXTS = new Set([
  ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".ts",
  ".ass", ".srt", ".ssa",
  ".nfo",
]);

const LIBRARY_DELETE_POLL_MS = 5_000;

// Keep library imports serialized so two low-space jobs cannot fill the disk
// while they are both waiting for MoviePilot to consume their files.
let libraryQueue: Promise<void> = Promise.resolve();

export interface LibraryResult {
  copied: string[];
  skipped: string[];
  error?: string;
}

export async function copyToLibrary(jobId: string): Promise<LibraryResult> {
  const previous = libraryQueue;
  let releaseQueue!: () => void;
  libraryQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await previous;
  try {
    return await copyToLibraryInternal(jobId);
  } finally {
    releaseQueue();
  }
}

async function copyToLibraryInternal(jobId: string): Promise<LibraryResult> {
  const libraryPath = config.paths.library;
  if (!libraryPath) {
    return { copied: [], skipped: [], error: "LIBRARY_PATH 未設定" };
  }

  const pending = getPendingAction(jobId);
  if (!pending) {
    return { copied: [], skipped: [], error: "找不到待處理的檔案記錄" };
  }

  const files: string[] = JSON.parse(pending.files);
  const existingFiles = files.filter((f) => {
    if (!fs.existsSync(f)) return false;
    const ext = path.extname(f).toLowerCase();
    return LIBRARY_EXTS.has(ext);
  });
  if (existingFiles.length === 0) {
    return { copied: [], skipped: [], error: "沒有符合入庫條件的檔案" };
  }

  // Determine destination: if files share a common parent folder name, preserve it
  const destDir = resolveDestDir(existingFiles, libraryPath);

  // Use the normal batch copy when the entire job fits. When it does not,
  // hand files to MoviePilot one at a time and wait for each one to be
  // consumed before copying the next file.
  const totalSize = existingFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  let sequential = false;
  try {
    const diskInfo = await checkDiskSpace(libraryPath);
    if (diskInfo.free < totalSize * 1.05) {
      sequential = true;
      logger.info(
        { jobId, totalSize, free: diskInfo.free },
        "Library disk space is low; switching to sequential import"
      );
    }
  } catch (err) {
    logger.error(err, "Failed to check library disk space");
    return { copied: [], skipped: [], error: "無法確認目標磁碟空間" };
  }

  fs.mkdirSync(destDir, { recursive: true });

  const copied: string[] = [];
  const skipped: string[] = [];

  for (let index = 0; index < existingFiles.length; index++) {
    const file = existingFiles[index];
    const filename = path.basename(file);
    const dest = path.join(destDir, filename);

    if (fs.existsSync(dest)) {
      skipped.push(filename);
      continue;
    }

    try {
      if (sequential) {
        const diskInfo = await checkDiskSpace(libraryPath);
        const fileSize = fs.statSync(file).size;
        if (diskInfo.free < fileSize * 1.05) {
          const need = (fileSize / 1024 / 1024 / 1024).toFixed(2);
          const free = (diskInfo.free / 1024 / 1024 / 1024).toFixed(2);
          return {
            copied,
            skipped,
            error: `磁碟空間不足，無法搬入 ${filename}: 需要 ${need} GB，剩餘 ${free} GB`,
          };
        }
      }

      fs.copyFileSync(file, dest);
      copied.push(filename);

      if (sequential && index < existingFiles.length - 1) {
        logger.info({ jobId, file: filename }, "Waiting for MoviePilot to consume library file");
        await waitUntilRemoved(dest);
      }
    } catch (err) {
      logger.error(err, `Failed to copy ${filename} to library`);
      return {
        copied,
        skipped,
        error: `搬入 ${filename} 失敗: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  logger.info(
    { jobId, copied: copied.length, skipped: skipped.length, dest: destDir, sequential },
    "Library copy complete"
  );
  return { copied, skipped };
}

async function waitUntilRemoved(file: string): Promise<void> {
  while (fs.existsSync(file)) {
    await new Promise<void>((resolve) => setTimeout(resolve, LIBRARY_DELETE_POLL_MS));
  }
}

function resolveDestDir(files: string[], libraryPath: string): string {
  if (files.length <= 1) return libraryPath;

  const dirs = files.map((f) => path.dirname(f));
  const common = dirs[0];
  const allSameDir = dirs.every((d) => d === common);

  if (allSameDir) {
    const folderName = path.basename(common);
    if (folderName && folderName !== "." && folderName !== "/") {
      return path.join(libraryPath, folderName);
    }
  }

  return libraryPath;
}
