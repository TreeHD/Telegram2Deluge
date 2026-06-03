import { Api, InlineKeyboard } from "grammy";
import { config, logger } from "../config.js";
import { splitToZip } from "./zipper.js";
import { compressVideo } from "./ffmpeg.js";
import { uploadToR2, getPresignedUrl } from "../storage/r2.js";
import { uploadToTelegram, buildMessageLink } from "../storage/telegram.js";
import { isVideoFile } from "./utils.js";
import { QBClient } from "../qb/client.js";
import { withRetry } from "../utils/retry.js";
import { escapeHtml, escapeHref } from "../utils/html.js";
import {
  addPipelineJob,
  updateJobStatus,
  getNextPendingJob,
  addPendingAction,
  getPendingAction,
  removePendingAction,
  getJobById,
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

      await this.editStatus(
        job.chat_id,
        job.message_id,
        `${job.name}\n\n上傳到 Telegram 中... (0/${outputFiles.length})`
      );

      const fileLinks: string[] = [];
      for (let i = 0; i < outputFiles.length; i++) {
        const file = outputFiles[i];
        const result = await uploadToTelegram(this.api, uploadChatId, file);
        const link = buildMessageLink(uploadChatId, result.messageId);
        const filename = path.basename(file);
        const displayName = truncateFilename(filename, 60);
        fileLinks.push(`<a href="${escapeHref(link)}">${escapeHtml(displayName)}</a>`);

        await this.editStatus(
          job.chat_id,
          job.message_id,
          `${job.name}\n\n上傳到 Telegram 中... (${i + 1}/${outputFiles.length})`
        );
      }

      addPendingAction(job.id, job.chat_id, outputFiles, downloadPath);

      const keyboard = new InlineKeyboard()
        .text("上傳到 R2", `r2_yes:${job.id}`)
        .text("不用了", `r2_no:${job.id}`)
        .row()
        .text("刪除原始檔", `del:${job.id}`);

      const header = `${escapeHtml(truncateFilename(job.name, 100))}\n\n`;
      const footer = `\n\n選擇後續動作：`;
      const chunks = splitLinksIntoChunks(fileLinks, 4000 - header.length - footer.length);

      // First chunk: edit the original message
      const firstText = header + chunks[0] + footer;
      await withRetry(async () => {
        await this.api.editMessageText(job.chat_id, job.message_id, firstText, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        });
      }, "pipeline:finalEdit");

      // Remaining chunks: send as new messages in the thread
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

  async uploadToR2ForJob(jobId: string, chatId: number, messageId: number): Promise<string[]> {
    const pending = getPendingAction(jobId);
    if (!pending) return [];

    const files: string[] = JSON.parse(pending.files);
    const urls: string[] = [];

    for (const file of files) {
      const filename = path.basename(file);
      const r2Key = `${jobId}/${filename}`;
      await uploadToR2(file, r2Key);
      const url = await getPresignedUrl(r2Key);
      urls.push(`<a href="${escapeHref(url)}">${escapeHtml(filename)}</a>`);
    }

    this.cleanupProcessing(files);
    this.deleteDownload(pending.download_path);
    removePendingAction(jobId);
    return urls;
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
        const compressed = await compressVideo(filePath, targetSize);
        if (compressed) {
          outputFiles.push(compressed);
        } else {
          const parts = await splitToZip(filePath, targetSize);
          outputFiles.push(...parts);
        }
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
