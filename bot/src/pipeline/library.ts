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

export interface LibraryResult {
  copied: string[];
  skipped: string[];
  error?: string;
}

export async function copyToLibrary(jobId: string): Promise<LibraryResult> {
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

  // Check disk space
  const totalSize = existingFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  try {
    const diskInfo = await checkDiskSpace(libraryPath);
    if (diskInfo.free < totalSize * 1.05) {
      const need = (totalSize / 1024 / 1024 / 1024).toFixed(2);
      const free = (diskInfo.free / 1024 / 1024 / 1024).toFixed(2);
      return { copied: [], skipped: [], error: `磁碟空間不足: 需要 ${need} GB，剩餘 ${free} GB` };
    }
  } catch (err) {
    logger.error(err, "Failed to check library disk space");
    return { copied: [], skipped: [], error: "無法確認目標磁碟空間" };
  }

  fs.mkdirSync(destDir, { recursive: true });

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const file of existingFiles) {
    const filename = path.basename(file);
    const dest = path.join(destDir, filename);

    if (fs.existsSync(dest)) {
      skipped.push(filename);
      continue;
    }

    try {
      fs.copyFileSync(file, dest);
      copied.push(filename);
    } catch (err) {
      logger.error(err, `Failed to copy ${filename} to library`);
      skipped.push(filename);
    }
  }

  logger.info({ jobId, copied: copied.length, skipped: skipped.length, dest: destDir }, "Library copy complete");
  return { copied, skipped };
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
