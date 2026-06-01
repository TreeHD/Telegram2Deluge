import fs from "node:fs";
import path from "node:path";
import { config, logger } from "../config.js";
import { QBClient } from "../qb/client.js";

let qbClient: QBClient | null = null;

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
  const maxAgeMs = config.cleanup.maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  // Clean up old files from disk
  cleanupDisk(maxAgeMs, now);

  // Clean up old completed torrents from qBittorrent
  await cleanupQB(maxAgeMs, now);
}

function cleanupDisk(maxAgeMs: number, now: number) {
  const dir = config.paths.downloads;

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
