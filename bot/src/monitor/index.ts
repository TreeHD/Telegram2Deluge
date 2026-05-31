import { QBClient } from "../qb/client.js";
import { Pipeline } from "../pipeline/index.js";
import { logger } from "../config.js";

interface TrackedTorrent {
  hash: string;
  chatId: number;
  lastProgress: number;
}

const POLL_INTERVAL = 5000;
const PROGRESS_NOTIFY_STEP = 10;

export class DownloadMonitor {
  private qb: QBClient;
  private pipeline: Pipeline | null = null;
  private tracked = new Map<string, TrackedTorrent>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(qb: QBClient) {
    this.qb = qb;
  }

  setPipeline(pipeline: Pipeline) {
    this.pipeline = pipeline;
  }

  track(hash: string, chatId: number) {
    this.tracked.set(hash, { hash, chatId, lastProgress: 0 });
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
    if (this.tracked.size === 0) return;

    try {
      for (const [hash, info] of this.tracked) {
        const torrent = await this.qb.getTorrentInfo(hash);
        if (!torrent) continue;

        const progress = Math.floor(torrent.progress * 100);
        const prevProgress = info.lastProgress;

        if (progress >= prevProgress + PROGRESS_NOTIFY_STEP) {
          info.lastProgress = progress;
          logger.info({ hash, chatId: info.chatId, progress, name: torrent.name }, "Download progress");
        }

        const doneStates = ["uploading", "pausedUP", "stalledUP", "queuedUP", "forcedUP"];
        if (torrent.progress >= 1 && doneStates.includes(torrent.state)) {
          this.tracked.delete(hash);
          logger.info({ hash, name: torrent.name }, "Download complete");

          if (this.pipeline) {
            const files = await this.qb.getTorrentFiles(hash);
            this.pipeline.enqueue({
              torrentId: hash,
              chatId: info.chatId,
              name: torrent.name,
              savePath: torrent.save_path,
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
}
