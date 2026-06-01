import { Api, InlineKeyboard } from "grammy";
import { QBClient } from "../qb/client.js";
import { Pipeline } from "../pipeline/index.js";
import { config, logger } from "../config.js";
import { withRetry } from "../utils/retry.js";
import {
  addTrackedTorrent,
  updateTrackedProgress,
  removeTrackedTorrent,
  getAllTrackedTorrents,
} from "../db/index.js";

interface TrackedTorrent {
  hash: string;
  chatId: number;
  messageId: number;
  lastProgress: number;
  lastUpdate: number;
}

const POLL_INTERVAL = 5000;
const UPDATE_INTERVAL = 15000;

export class DownloadMonitor {
  private qb: QBClient;
  private pipeline: Pipeline | null = null;
  private api: Api | null = null;
  private tracked = new Map<string, TrackedTorrent>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(qb: QBClient) {
    this.qb = qb;
    this.loadFromDb();
  }

  private loadFromDb() {
    const rows = getAllTrackedTorrents();
    for (const row of rows) {
      this.tracked.set(row.hash, {
        hash: row.hash,
        chatId: row.chat_id,
        messageId: row.message_id,
        lastProgress: row.last_progress,
        lastUpdate: 0,
      });
    }
    if (rows.length > 0) {
      logger.info({ count: rows.length }, "Restored tracked torrents from DB");
    }
  }

  setPipeline(pipeline: Pipeline) {
    this.pipeline = pipeline;
  }

  setApi(api: Api) {
    this.api = api;
  }

  track(hash: string, chatId: number, messageId: number) {
    this.tracked.set(hash, { hash, chatId, messageId, lastProgress: 0, lastUpdate: 0 });
    addTrackedTorrent(hash, chatId, messageId);
  }

  async cancelTorrent(hash: string): Promise<boolean> {
    const info = this.tracked.get(hash);
    if (!info) return false;

    this.tracked.delete(hash);
    removeTrackedTorrent(hash);
    await this.qb.deleteTorrent(hash, true);
    return true;
  }

  getTracked(hash: string) {
    return this.tracked.get(hash);
  }

  start() {
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll() {
    if (this.tracked.size === 0 || !this.api) return;

    try {
      for (const [hash, info] of this.tracked) {
        const torrent = await this.qb.getTorrentInfo(hash);
        if (!torrent) continue;

        const progress = Math.floor(torrent.progress * 100);
        const now = Date.now();

        if (progress !== info.lastProgress && now - info.lastUpdate >= UPDATE_INTERVAL) {
          info.lastProgress = progress;
          info.lastUpdate = now;
          updateTrackedProgress(hash, progress);

          const speed = (torrent.dlspeed / 1024 / 1024).toFixed(2);
          const eta = torrent.eta > 0 && torrent.eta < 8640000 ? formatEta(torrent.eta) : "計算中...";
          const bar = progressBar(progress);

          const text =
            `${torrent.name}\n\n` +
            `${bar} ${progress}%\n` +
            `速度: ${speed} MB/s | ETA: ${eta}`;

          const keyboard = new InlineKeyboard().text("停止並刪除", `cancel:${hash}`);
          await this.editMessage(info.chatId, info.messageId, text, keyboard);
        }

        const doneStates = ["uploading", "pausedUP", "stalledUP", "queuedUP", "forcedUP"];
        if (torrent.progress >= 1 && doneStates.includes(torrent.state)) {
          this.tracked.delete(hash);
          removeTrackedTorrent(hash);

          // Stop seeding immediately
          await this.qb.pauseTorrent(hash);

          const text = `${torrent.name}\n\n下載完成，開始處理...`;
          await this.editMessage(info.chatId, info.messageId, text);

          logger.info({ hash, name: torrent.name }, "Download complete");

          if (this.pipeline) {
            const files = await this.qb.getTorrentFiles(hash);
            this.pipeline.enqueue({
              torrentId: hash,
              chatId: info.chatId,
              messageId: info.messageId,
              name: torrent.name,
              savePath: config.paths.downloads,
              files: files.map((f) => ({ path: f.name, size: f.size })),
              totalSize: torrent.size,
            });
          }
        }
      }
    } catch (err) {
      logger.error(err, "Monitor poll error");
    }
  }

  private async editMessage(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard) {
    await withRetry(async () => {
      const opts: any = {};
      if (keyboard) opts.reply_markup = keyboard;
      await this.api!.editMessageText(chatId, messageId, text, opts);
    }, "monitor:editMessage").catch((err: any) => {
      if (!err?.description?.includes("message is not modified")) {
        logger.error(err, "Failed to edit message");
      }
    });
  }
}

function progressBar(percent: number): string {
  const filled = Math.floor(percent / 5);
  const empty = 20 - filled;
  return "▓".repeat(filled) + "░".repeat(empty);
}

function formatEta(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
