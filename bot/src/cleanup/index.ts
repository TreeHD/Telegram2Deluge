import fs from "node:fs";
import path from "node:path";
import { config, logger } from "../config.js";
import { QBClient } from "../qb/client.js";
import { getAllPendingActions, removePendingAction, updateJobStatus } from "../db/index.js";

let qbClient: QBClient | null = null;

/** Drop old /processing artifacts, and requeue actions that need regenerated mux outputs. */
export function clearProcessingOnStartup() {
  const processingDir = path.resolve(config.paths.processing);
  const protectedPaths = [config.paths.downloads, config.paths.queue, config.paths.library]
    .filter((value) => value.length > 0).map((value) => path.resolve(value));
  if (processingDir === path.parse(processingDir).root ||
      protectedPaths.some((protectedPath) =>
        protectedPath === processingDir || protectedPath.startsWith(`${processingDir}${path.sep}`))) {
    throw new Error(`Unsafe PROCESSING_DIR for startup cleanup: ${processingDir}`);
  }
  if (fs.lstatSync(processingDir).isSymbolicLink()) {
    throw new Error(`PROCESSING_DIR must not be a symlink: ${processingDir}`);
  }

  let requeued = 0;
  for (const pending of getAllPendingActions()) {
    let files: unknown;
    try {
      files = JSON.parse(pending.files);
    } catch (err) {
      logger.error({ err, jobId: pending.job_id }, "Invalid pending action file list");
      continue;
    }
    if (!Array.isArray(files) || !files.some((file) =>
      typeof file === "string" &&
      path.resolve(file).startsWith(`${processingDir}${path.sep}`))) {
      continue;
    }
    removePendingAction(pending.job_id);
    updateJobStatus(pending.job_id, "pending");
    requeued++;
  }

  let removed = 0;
  for (const entry of fs.readdirSync(processingDir)) {
    fs.rmSync(path.join(processingDir, entry), { recursive: true, force: true });
    removed++;
  }
  logger.info({ processingDir, removed, requeued }, "Cleared processing directory on startup");
}

export function startCleanupScheduler(qb: QBClient) {
  qbClient = qb;
  const intervalMs = config.cleanup.intervalMinutes * 60 * 1000;
  setInterval(cleanup, intervalMs);
  logger.info(
    { maxAgeHours: config.cleanup.maxAgeHours, intervalMinutes: config.cleanup.intervalMinutes },
    "Cleanup scheduler started"
  );
}

async function cleanup() {
  try {
    const maxAgeMs = config.cleanup.maxAgeHours * 60 * 60 * 1000;
    const now = Date.now();

    cleanupDisk(config.paths.downloads, maxAgeMs, now);
    cleanupDisk(config.paths.processing, maxAgeMs, now);
    await cleanupQB(maxAgeMs, now);
  } catch (err) {
    logger.error(err, "Cleanup cycle failed");
  }
}

function cleanupDisk(dir: string, maxAgeMs: number, now: number) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        const age = now - stat.mtimeMs;

        if (age > maxAgeMs) {
          if (entry.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          logger.info({ path: fullPath, ageHours: (age / 3600000).toFixed(1) }, "Cleaned up old file");
        }
      } catch (err) {
        logger.error(err, `Failed to clean up: ${fullPath}`);
      }
    }
  } catch (err) {
    logger.error(err, "Cleanup disk scan failed");
  }
}

async function cleanupQB(maxAgeMs: number, now: number) {
  if (!qbClient) return;

  try {
    const torrents = await qbClient.getTorrents();

    for (const torrent of torrents) {
      // completion_on is unix timestamp (seconds) when torrent finished, 0 or -1 if not complete
      const completionOn = (torrent as any).completion_on;
      if (!completionOn || completionOn <= 0) continue;

      const completedAt = completionOn * 1000;
      const age = now - completedAt;

      if (age > maxAgeMs) {
        await qbClient.deleteTorrent(torrent.hash, true);
        logger.info({ hash: torrent.hash, name: torrent.name, ageHours: (age / 3600000).toFixed(1) }, "Cleaned up old torrent from qBittorrent");
      }
    }
  } catch (err) {
    logger.error(err, "Cleanup qBittorrent scan failed");
  }
}
