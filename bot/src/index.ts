import { config, logger } from "./config.js";
import { createBot, Services } from "./bot/index.js";
import { QBClient } from "./qb/client.js";
import { startTrackerUpdater } from "./qb/trackers.js";
import { DownloadMonitor } from "./monitor/index.js";
import { Pipeline } from "./pipeline/index.js";
import { startCleanupScheduler } from "./cleanup/index.js";
import fs from "node:fs";

async function connectWithRetry(qb: QBClient, maxRetries = 30, interval = 3000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await qb.connect();
      return;
    } catch (err) {
      if (i === maxRetries) throw err;
      logger.warn(`qBittorrent connection failed (attempt ${i}/${maxRetries}), retrying in ${interval / 1000}s...`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

async function main() {
  for (const dir of [config.paths.downloads, config.paths.processing, config.paths.queue]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const qb = new QBClient(config.qb);
  await connectWithRetry(qb);
  logger.info("Connected to qBittorrent");

  startTrackerUpdater();
  startCleanupScheduler(qb);

  const monitor = new DownloadMonitor(qb);
  const services: Services = { qb, monitor };
  const bot = createBot(services);
  const pipeline = new Pipeline(bot.api);
  services.pipeline = pipeline;
  monitor.setPipeline(pipeline);
  monitor.setApi(bot.api);

  monitor.start();
  logger.info("Download monitor started");

  await bot.start({
    onStart: () => logger.info("Bot started"),
  });
}

main().catch((err) => {
  logger.fatal(err, "Fatal error");
  process.exit(1);
});
