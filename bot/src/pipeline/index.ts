import { Api, InlineKeyboard } from "grammy";
import { config, logger } from "../config.js";
import { splitToZip } from "./zipper.js";
import { splitVideo } from "./ffmpeg.js";
import { uploadToR2, getPresignedUrl } from "../storage/r2.js";
import { uploadToFilebin, getFilebinBinUrl } from "../storage/filebin.js";
import { uploadToTelegram, buildMessageLink } from "../storage/telegram.js";
import { isVideoFile } from "./utils.js";
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
  addStreamFile,
  getStreamFiles,
} from "../db/index.js";
import path from "node:path";
import fs from "node:fs";

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

      const uploadChatId = config.uploadChatId || job.chat_id;

      // Check which files were already uploaded (resumption support)
      const existingStreams = getStreamFiles(job.id);
      const alreadyUploaded = new Set(existingStreams.map((s) => s.filename));
      const filesToUpload = outputFiles.filter((f) => !alreadyUploaded.has(path.basename(f)));

      if (filesToUpload.length > 0) {
        await this.editStatus(job.chat_id, job.message_id, `${job.name}\n\n上傳到 Telegram 中... (${existingStreams.length}/${outputFiles.length} 已完成)`);

        const uploadResults = await parallelMap(filesToUpload, async (file) => {
          const result = await uploadToTelegram(this.api, uploadChatId, file);
          const filename = path.basename(file);
          const fileSize = fs.statSync(file).size;
          addStreamFile(job.id, filename, result.fileId, fileSize, uploadChatId, result.messageId);
          return { file, result };
        }, 4);
      }

      // Build file links from all stream_files (includes previously uploaded)
      const allStreams = getStreamFiles(job.id);
      const fileLinks: string[] = [];
      for (const sf of allStreams) {
        const link = buildMessageLink(uploadChatId, sf.message_id);
        const displayName = truncateFilename(sf.filename, 60);
        fileLinks.push(`<a href="${escapeHref(link)}">${escapeHtml(displayName)}</a>`);
      }

      addPendingAction(job.id, job.chat_id, outputFiles, downloadPath);

      // Send a new message with file links + action buttons
      const keyboard = new InlineKeyboard()
        .text("上傳 R2", `r2_yes:${job.id}`)
        .text("上傳 Filebin", `fb_yes:${job.id}`);
      if (config.streamHost) {
        keyboard.text("Stream 直鏈", `st_yes:${job.id}`);
      }
      keyboard.row().text("🗑️ 刪除原始檔", `del:${job.id}`);

      const header = `${escapeHtml(truncateFilename(job.name, 100))}\n\n`;
      const footer = `\n\n選擇後續動作：`;
      const chunks = splitLinksIntoChunks(fileLinks, 4000 - header.length - footer.length);

      const firstText = header + chunks[0] + footer;
      await withRetry(async () => {
        await this.api.sendMessage(job.chat_id, firstText, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
          reply_to_message_id: job.message_id,
        } as any);
      }, "pipeline:resultMessage");

      for (let i = 1; i < chunks.length; i++) {
        await withRetry(async () => {
          await this.api.sendMessage(job.chat_id, chunks[i], {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_to_message_id: job.message_id,
          } as any);
        }, "pipeline:overflowMessage");
      }

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
      try { fs.unlinkSync(m3u8Path); } catch {}
    }

    this.cleanupProcessing(files);
    this.deleteDownload(pending.download_path);
    removePendingAction(jobId);
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
    const targetSize = config.split.targetSizeMb;

    for (const file of files) {
      const filePath = path.join(savePath, file.path);

      if (!fs.existsSync(filePath)) {
        logger.warn({ path: filePath }, "File not found, skipping");
        continue;
      }

      const fileSize = fs.statSync(filePath).size;
      const sizeMb = fileSize / 1024 / 1024;

      if (sizeMb <= targetSize) {
        outputFiles.push(filePath);
      } else if (isVideoFile(filePath)) {
        const parts = await splitVideo(filePath, targetSize);
        outputFiles.push(...parts);
      } else {
        const parts = await splitToZip(filePath, targetSize);
        outputFiles.push(...parts);
      }
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

function splitLinksIntoChunks(links: string[], firstChunkMax: number): string[] {
  const chunks: string[] = [];
  let current = "";

  const maxLen = firstChunkMax;

  for (const link of links) {
    const line = current.length === 0 ? link : `\n${link}`;
    const limit = chunks.length === 0 ? maxLen : 4000;

    if (current.length + line.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = link;
      } else {
        chunks.push(link);
      }
    } else {
      current += line;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [""];
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
