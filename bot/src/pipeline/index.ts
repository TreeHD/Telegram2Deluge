import { Api, InlineKeyboard } from "grammy";
import { config, logger } from "../config.js";
import { splitTo7z } from "./zipper.js";
import { muxSubtitles } from "./mux.js";
import { uploadToR2, getPresignedUrl } from "../storage/r2.js";
import { uploadToFilebin, getFilebinBinUrl } from "../storage/filebin.js";
import { QBClient } from "../qb/client.js";
import { withRetry } from "../utils/retry.js";
import { escapeHtml, escapeHref } from "../utils/html.js";
import { generateM3u8 } from "../utils/m3u8.js";
import {
  addPipelineJob,
  updateJobStatus,
  getNextPendingJob,
  resetAllInterruptedJobs,
  addPendingAction,
  getPendingAction,
  removePendingAction,
  getJobById,
} from "../db/index.js";
import path from "node:path";
import fs from "node:fs";

export interface TelegramUploadFiles {
  files: string[];
  temporaryFiles: string[];
  groups: string[][];
}

export interface CompletedTorrent {
  torrentId: string;
  chatId: number;
  messageId: number;
  name: string;
  savePath: string;
  files: Array<{ path: string; size: number }>;
  totalSize: number;
}

export class Pipeline {
  private api: Api;
  private processing = false;

  constructor(api: Api) {
    this.api = api;
    this.resumePending();
  }

  private resumePending() {
    const reset = resetAllInterruptedJobs();
    if (reset > 0) {
      logger.info({ count: reset }, "Reset interrupted jobs back to pending");
    }
    const job = getNextPendingJob();
    if (job) {
      logger.info({ jobId: job.id, name: job.name }, "Resuming pending job from DB");
      this.processNext();
    }
  }

  enqueue(torrent: CompletedTorrent) {
    const id = `${Date.now()}-${torrent.torrentId.slice(0, 8)}`;
    addPipelineJob({
      id,
      torrentId: torrent.torrentId,
      chatId: torrent.chatId,
      messageId: torrent.messageId,
      name: torrent.name,
      savePath: torrent.savePath,
      files: torrent.files,
      totalSize: torrent.totalSize,
      status: "pending",
    });

    logger.info({ jobId: id, name: torrent.name }, "Job enqueued");
    this.processNext();
  }

  retrigger() {
    this.processNext();
  }

  private async processNext() {
    if (this.processing) return;

    const job = getNextPendingJob();
    if (!job) return;

    this.processing = true;
    updateJobStatus(job.id, "processing");

    try {
      await this.editStatus(job.chat_id, job.message_id, `${job.name}\n\n處理中...`);

      const jobFiles: Array<{ path: string; size: number }> = JSON.parse(job.files);
      const outputFiles = await this.processFiles(job.save_path, jobFiles);
      const downloadPath = this.resolveDownloadPath(job.save_path, jobFiles);

      addPendingAction(job.id, job.chat_id, outputFiles, downloadPath);

      // Send completion message with action buttons (no auto-upload)
      const keyboard = new InlineKeyboard()
        .text("上傳 R2", `r2_yes:${job.id}`);
      if (config.streamHost) {
        keyboard.text("Stream 直鏈", `st_yes:${job.id}`);
      }
      if (config.paths.library) {
        keyboard.text("📂 入庫", `lib:${job.id}`);
      }
      keyboard.row().text("🗑️ 刪除原始檔", `del:${job.id}`);

      const text = `${escapeHtml(truncateFilename(job.name, 100))}\n\n✅ 處理完成 (${outputFiles.length} 個檔案)\n選擇後續動作：`;
      await withRetry(async () => {
        await this.api.sendMessage(job.chat_id, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
          reply_to_message_id: job.message_id,
        } as any);
      }, "pipeline:resultMessage");

      updateJobStatus(job.id, "done");
    } catch (err) {
      logger.error(err, "Pipeline error");
      updateJobStatus(job.id, "failed");
      await this.editStatus(job.chat_id, job.message_id, `${job.name}\n\n處理失敗: ${err}`);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }

  private async editStatus(chatId: number, messageId: number, text: string, opts?: any) {
    await withRetry(async () => {
      await this.api.editMessageText(chatId, messageId, text, opts);
    }, "editStatus").catch((err: any) => {
      if (!err?.description?.includes("message is not modified")) {
        logger.error(err, "Failed to edit status message");
      }
    });
  }

  async uploadToR2ForJob(jobId: string): Promise<string[]> {
    const pending = getPendingAction(jobId);
    if (!pending) return [];

    const files: string[] = JSON.parse(pending.files);

    const results = await parallelMap(files, async (file) => {
      const filename = path.basename(file);
      const r2Key = `${jobId}/${filename}`;
      await uploadToR2(file, r2Key);
      const url = await getPresignedUrl(r2Key);
      return { filename, url };
    }, 6);

    const urls: string[] = results.map((r) =>
      `<a href="${escapeHref(r.url)}">${escapeHtml(r.filename)}</a>`
    );

    const m3u8Content = generateM3u8(results);
    if (m3u8Content) {
      const m3u8Key = `${jobId}/playlist.m3u8`;
      const m3u8Path = path.join(config.paths.processing, `${jobId}-playlist.m3u8`);
      fs.writeFileSync(m3u8Path, m3u8Content);
      await uploadToR2(m3u8Path, m3u8Key);
      const m3u8Url = await getPresignedUrl(m3u8Key);
      urls.push(`<a href="${escapeHref(m3u8Url)}">📋 playlist.m3u8</a>`);
    }

    return urls;
  }

  async uploadToFilebinForJob(jobId: string): Promise<{ links: string[]; skipped: string[]; binUrl: string }> {
    const pending = getPendingAction(jobId);
    if (!pending) return { links: [], skipped: [], binUrl: "" };

    const files: string[] = JSON.parse(pending.files);
    const binId = `tg-${jobId}`;

    const results = await parallelMap(files, async (file) => {
      const result = await uploadToFilebin(file, binId);
      return { file, result };
    }, 6);

    const links: string[] = [];
    const skipped: string[] = [];
    const videoEntries: Array<{ filename: string; url: string }> = [];

    for (const { file, result } of results) {
      if (result) {
        links.push(`<a href="${escapeHref(result.url)}">${escapeHtml(result.filename)}</a>`);
        videoEntries.push({ filename: result.filename, url: result.url });
      } else {
        skipped.push(path.basename(file));
      }
    }

    const m3u8Content = generateM3u8(videoEntries);
    if (m3u8Content) {
      const m3u8Path = path.join(config.paths.processing, `${jobId}-playlist.m3u8`);
      fs.writeFileSync(m3u8Path, m3u8Content);
      const result = await uploadToFilebin(m3u8Path, binId);
      if (result) {
        links.push(`<a href="${escapeHref(result.url)}">📋 playlist.m3u8</a>`);
      }
      try { fs.unlinkSync(m3u8Path); } catch {}
    }

    return { links, skipped, binUrl: getFilebinBinUrl(binId) };
  }

  getPendingR2(jobId: string) {
    return getPendingAction(jobId);
  }

  removePendingR2(jobId: string) {
    removePendingAction(jobId);
  }

  /**
   * Telegram's local Bot API accepts files up to 2 GB.  Keep pending-action
   * files intact for R2 and library imports, and create split copies only
   * immediately before a Telegram upload.
   */
  async prepareFilesForTelegramUpload(files: string[]): Promise<TelegramUploadFiles> {
    const uploadFiles: string[] = [];
    const temporaryFiles: string[] = [];
    const temporaryDirectories: string[] = [];
    const groups: string[][] = [];
    const targetSize = config.split.targetSizeMb;
    const targetBytes = targetSize * 1024 * 1024;
    if (targetBytes <= 0) throw new Error("SPLIT_TARGET_SIZE_MB must be positive");

    try {
      for (const file of files) {
        if (!fs.existsSync(file)) continue;

        if (fs.statSync(file).size <= targetBytes) {
          uploadFiles.push(file);
          groups.push([file]);
          continue;
        }

        // Separate each source file and upload attempt from other split output.
        fs.mkdirSync(config.paths.processing, { recursive: true });
        const temporaryDir = fs.mkdtempSync(path.join(config.paths.processing, "telegram-"));
        temporaryDirectories.push(temporaryDir);
        // Use the same recoverable archive format for every oversized file.
        const parts = await splitTo7z(file, targetSize, temporaryDir);

        uploadFiles.push(...parts);
        groups.push(parts);
        temporaryFiles.push(...parts);
      }
    } catch (err) {
      for (const directory of temporaryDirectories) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
      throw err;
    }

    return { files: uploadFiles, temporaryFiles, groups };
  }

  retainTelegramUploadFiles(files: string[]) {
    const processingDir = path.resolve(config.paths.processing);
    const directories = new Set(files.map((file) => path.dirname(file)));
    const now = new Date();
    for (const directory of directories) {
      if (path.dirname(path.resolve(directory)) !== processingDir || !path.basename(directory).startsWith("telegram-")) {
        continue;
      }
      try { fs.utimesSync(directory, now, now); } catch {}
    }
  }

  deleteJobFiles(jobId: string) {
    const pending = getPendingAction(jobId);
    if (!pending) return;
    const files: string[] = JSON.parse(pending.files);
    this.cleanupProcessing(files);
    this.deleteDownload(pending.download_path);
    removePendingAction(jobId);
  }

  async deleteJobAndTorrent(jobId: string, qb: QBClient) {
    const job = getJobById(jobId);
    const pending = getPendingAction(jobId);

    if (pending) {
      const files: string[] = JSON.parse(pending.files);
      this.cleanupProcessing(files);
      this.deleteDownload(pending.download_path);
      removePendingAction(jobId);
    }

    if (job) {
      try {
        await qb.deleteTorrent(job.torrent_id, true);
      } catch (err) {
        logger.error(err, "Failed to delete torrent from qBittorrent");
      }
    }
  }

  deleteDownload(downloadPath: string) {
    try {
      if (!fs.existsSync(downloadPath)) return;
      const stat = fs.statSync(downloadPath);
      if (stat.isDirectory()) {
        fs.rmSync(downloadPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(downloadPath);
      }
      logger.info({ path: downloadPath }, "Deleted download");
    } catch (err) {
      logger.error(err, "Failed to delete download");
    }
  }

  private resolveDownloadPath(savePath: string, files: Array<{ path: string; size: number }>): string {
    if (files.length === 0) return savePath;
    // qB file paths are relative to savePath, e.g. "TorrentName/file.mp4" or just "file.mp4"
    const first = files[0].path;
    const topDir = first.split("/")[0];
    // If all files share the same top-level directory, that's the download folder to clean up
    if (files.length > 1 || first.includes("/")) {
      return path.join(savePath, topDir);
    }
    return path.join(savePath, first);
  }

  private async processFiles(savePath: string, files: Array<{ path: string; size: number }>): Promise<string[]> {
    const outputFiles: string[] = [];

    // Collect all file paths
    const allPaths = files.map((f) => path.join(savePath, f.path)).filter((f) => fs.existsSync(f));

    // Attempt subtitle muxing
    const muxResults = await muxSubtitles(allPaths, config.paths.processing);
    const skipSet = new Set<string>();
    for (const result of muxResults) {
      skipSet.add(result.videoPath);
      for (const sub of result.subtitlePaths) {
        skipSet.add(sub);
      }
      outputFiles.push(result.outputPath);
    }

    for (const file of files) {
      const filePath = path.join(savePath, file.path);

      if (!fs.existsSync(filePath)) {
        logger.warn({ path: filePath }, "File not found, skipping");
        continue;
      }

      if (skipSet.has(filePath)) continue;

      // Skip standalone subtitle files if videos were muxed
      const ext = path.extname(filePath).toLowerCase();
      if (muxResults.length > 0 && (ext === ".ass" || ext === ".srt" || ext === ".ssa")) continue;

      // Do not split here. Pending files are used by R2 and library imports,
      // both of which must receive the original file.
      outputFiles.push(filePath);
    }

    return outputFiles;
  }

  private cleanupProcessing(files: string[]) {
    for (const file of files) {
      if (file.startsWith(config.paths.processing)) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  }
}

function truncateFilename(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const ext = path.extname(name);
  const base = name.slice(0, maxLen - ext.length - 3);
  return `${base}...${ext}`;
}

async function parallelMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
