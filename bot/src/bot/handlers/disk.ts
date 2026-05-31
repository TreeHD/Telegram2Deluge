import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";
import checkDiskSpace from "check-disk-space";

export async function handleDisk(ctx: BotContext) {
  try {
    const info = await checkDiskSpace(config.paths.downloads);
    const free = (info.free / 1024 / 1024 / 1024).toFixed(2);
    const total = (info.size / 1024 / 1024 / 1024).toFixed(2);
    const used = ((info.size - info.free) / 1024 / 1024 / 1024).toFixed(2);
    const pct = (((info.size - info.free) / info.size) * 100).toFixed(1);

    await ctx.reply(
      `磁碟空間:\n` +
        `  總計: ${total} GB\n` +
        `  已用: ${used} GB (${pct}%)\n` +
        `  剩餘: ${free} GB`
    );
  } catch (err) {
    logger.error(err, "Failed to check disk space");
    await ctx.reply("取得磁碟空間失敗。");
  }
}
