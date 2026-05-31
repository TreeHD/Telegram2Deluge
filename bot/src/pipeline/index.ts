import { Api, InputFile, InlineKeyboard } from "grammy";
import { config, logger } from "../config.js";
import { JobQueue, PipelineJob } from "./queue.js";
import { splitToZip } from "./zipper.js";
import { uploadToR2, getPresignedUrl } from "../storage/r2.js";
import { uploadToTelegram } from "../storage/telegram.js";
import { getFilesInDir } from "./utils.js";
import path from "node:path";
import fs from "node:fs";

export interface CompletedTorrent {
  torrentId: string;
  chatId: number;
  name: string;
  savePath: string;
  files: Array<{ path: string; size: number }>;
  totalSize: number;
}

export class Pipeline {
  private api: Api;
  private queue: JobQueue;
  private processing = false;
  private pendingR2 = new Map<string, { chatId: number; files: string[]; jobId: string }>();

  constructor(api: Api) {
    this.api = api;
    this.queue = new JobQueue(config.paths.queue);
  }

  getPendingR2(jobId: string) {
    return this.pendingR2.get(jobId);
  }

  removePendingR2(jobId: string) {
    this.pendingR2.delete(jobId);
  }

  enqueue(torrent: CompletedTorrent) {
    const job: PipelineJob = {
      id: `${Date.now()}-${torrent.torrentId.slice(0, 8)}`,
      torrentId: torrent.torrentId,
      chatId: torrent.chatId,
      name: torrent.name,
      savePath: torrent.savePath,
      files: torrent.files,
      totalSize: torrent.totalSize,
      status: "pending",
    };

    this.queue.add(job);
    logger.info({ jobId: job.id, name: job.name }, "Job enqueued");
    this.processNext();
  }

  private async processNext() {
    if (this.processing) return;

    const job = this.queue.next();
    if (!job) return;

    this.processing = true;
    job.status = "processing";
    this.queue.save();

    try {
      await this.api.sendMessage(job.chatId, `開始處理: ${job.name}`);

      const outputFiles = await this.processFiles(job);

      // Send first file as the thread starter
      const threadMsg = await this.api.sendMessage(
        job.chatId,
        `上傳中: ${job.name} (${outputFiles.length} 個檔案)`
      );
      const threadId = threadMsg.message_id;

      for (const file of outputFiles) {
        await uploadToTelegram(this.api, job.chatId, file, threadId);
      }

      // Ask user if they want to upload to R2
      this.pendingR2.set(job.id, { chatId: job.chatId, files: outputFiles, jobId: job.id });

      const keyboard = new InlineKeyboard()
        .text("上傳到 R2", `r2_yes:${job.id}`)
        .text("不用了", `r2_no:${job.id}`);

      await this.api.sendMessage(
        job.chatId,
        `Telegram 上傳完成: ${job.name}\n要上傳到 R2 產生 24hr 下載連結嗎？`,
        { reply_to_message_id: threadId, reply_markup: keyboard }
      );

      job.status = "done";
      this.queue.save();
    } catch (err) {
      logger.error(err, "Pipeline error");
      job.status = "failed";
      this.queue.save();
      await this.api.sendMessage(job.chatId, `處理失敗: ${job.name}\n${err}`).catch(() => {});
    } finally {
      this.processing = false;
      this.processNext();
    }
  }

  async uploadToR2ForJob(jobId: string): Promise<string[]> {
    const pending = this.pendingR2.get(jobId);
    if (!pending) return [];

    const urls: string[] = [];
    for (const file of pending.files) {
      const filename = path.basename(file);
      const r2Key = `${jobId}/${filename}`;
      await uploadToR2(file, r2Key);
      const url = await getPresignedUrl(r2Key);
      urls.push(url);
    }

    this.cleanup(pending.files);
    this.pendingR2.delete(jobId);
    return urls;
  }

  private async processFiles(job: PipelineJob): Promise<string[]> {
    const outputFiles: string[] = [];
    const targetSize = config.split.targetSizeMb;

    const torrentPath = path.join(job.savePath, job.name);
    const stat = fs.statSync(torrentPath);
    const allFiles = stat.isDirectory() ? getFilesInDir(torrentPath) : [torrentPath];

    for (const filePath of allFiles) {
      const fileSize = fs.statSync(filePath).size;
      const sizeMb = fileSize / 1024 / 1024;

      if (sizeMb <= targetSize) {
        outputFiles.push(filePath);
      } else {
        const parts = await splitToZip(filePath, targetSize);
        outputFiles.push(...parts);
      }
    }

    return outputFiles;
  }

  private cleanup(files: string[]) {
    for (const file of files) {
      if (file.startsWith(config.paths.processing)) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  }
}
