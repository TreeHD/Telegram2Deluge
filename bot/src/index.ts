import { config, logger } from "./config.js";
import { createBot, Services } from "./bot/index.js";
import { DelugeClient } from "./deluge/client.js";
import { DownloadMonitor } from "./monitor/index.js";
import { Pipeline } from "./pipeline/index.js";
import fs from "node:fs";

async function connectWithRetry(deluge: DelugeClient, maxRetries = 30, interval = 3000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await deluge.connect();
      return;
    } catch (err) {
      if (i === maxRetries) throw err;
      logger.warn(`Deluge connection failed (attempt ${i}/${maxRetries}), retrying in ${interval / 1000}s...`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

async function main() {
  for (const dir of [config.paths.downloads, config.paths.processing, config.paths.queue]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const deluge = new DelugeClient(config.deluge);
  await connectWithRetry(deluge);
  logger.info("Connected to Deluge daemon");

  const monitor = new DownloadMonitor(deluge);
  const services: Services = { deluge, monitor };
  const bot = createBot(services);
  const pipeline = new Pipeline(bot.api);
  services.pipeline = pipeline;
  monitor.setPipeline(pipeline);

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
