import { config, logger } from "./config.js";
import { createBot, Services } from "./bot/index.js";
import { DelugeClient } from "./deluge/client.js";
import { DownloadMonitor } from "./monitor/index.js";
import { Pipeline } from "./pipeline/index.js";
import fs from "node:fs";

async function main() {
  for (const dir of [config.paths.downloads, config.paths.processing, config.paths.queue]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const deluge = new DelugeClient(config.deluge);
  await deluge.connect();
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
