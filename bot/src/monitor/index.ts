import { DelugeClient } from "../deluge/client.js";
import { Pipeline } from "../pipeline/index.js";
import { logger } from "../config.js";

interface TrackedTorrent {
  id: string;
  chatId: number;
  lastProgress: number;
}

const POLL_INTERVAL = 5000;
const PROGRESS_NOTIFY_STEP = 10;

export class DownloadMonitor {
  private deluge: DelugeClient;
  private pipeline: Pipeline | null = null;
  private tracked = new Map<string, TrackedTorrent>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deluge: DelugeClient) {
    this.deluge = deluge;
  }

  setPipeline(pipeline: Pipeline) {
    this.pipeline = pipeline;
  }

  track(torrentId: string, chatId: number) {
    this.tracked.set(torrentId, { id: torrentId, chatId, lastProgress: 0 });
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
      const statuses = await this.deluge.getTorrentsStatus(
        {},
        ["name", "progress", "state", "save_path", "files", "total_size"]
      );

      for (const [torrentId, info] of this.tracked) {
        const status = statuses[torrentId];
        if (!status) continue;

        const progress = Math.floor(status.progress);
        const prevProgress = info.lastProgress;

        if (progress >= prevProgress + PROGRESS_NOTIFY_STEP) {
          info.lastProgress = progress;
          logger.info({ torrentId, chatId: info.chatId, progress, name: status.name }, "Download progress");
        }

        if (status.progress >= 100 && (status.state === "Seeding" || status.state === "Paused")) {
          this.tracked.delete(torrentId);
          logger.info({ torrentId, name: status.name }, "Download complete");

          if (this.pipeline) {
            this.pipeline.enqueue({
              torrentId,
              chatId: info.chatId,
              name: status.name,
              savePath: status.save_path,
              files: status.files || [],
              totalSize: status.total_size,
            });
          }
        }
      }
    } catch (err) {
      logger.error(err, "Monitor poll error");
    }
  }
}
