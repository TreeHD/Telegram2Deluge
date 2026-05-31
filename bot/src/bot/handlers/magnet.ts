import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";
import { getTrackers } from "../../qb/trackers.js";

export async function handleMagnet(ctx: BotContext) {
  const text = ctx.message!.text!.trim();

  await ctx.reply("收到磁力鏈結，正在加入下載...");

  try {
    const hash = await ctx.qb.addTorrentMagnet(text, {
      savepath: config.paths.downloads,
    });

    if (!hash) {
      await ctx.reply("加入磁力鏈結失敗。");
      return;
    }

    // Add trackers
    const trackers = getTrackers();
    if (trackers.length > 0) {
      await ctx.qb.addTrackers(hash, trackers);
    }

    ctx.monitor.track(hash, ctx.chat!.id);
    await ctx.reply(`已加入下載佇列\nHash: \`${hash}\``, {
      parse_mode: "Markdown",
    });
    logger.info({ hash }, "Magnet added");
  } catch (err) {
    logger.error(err, "Failed to add magnet");
    await ctx.reply(`加入磁力鏈結失敗: ${err}`);
  }
}
