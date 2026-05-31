import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";

export async function handleMagnet(ctx: BotContext) {
  const text = ctx.message!.text!.trim();

  await ctx.reply("收到磁力鏈結，正在加入下載...");

  try {
    const torrentId = await ctx.deluge.addTorrentMagnet(text, {
      download_location: config.paths.downloads,
    });

    ctx.monitor.track(torrentId, ctx.chat!.id);
    await ctx.reply(`已加入下載佇列\nTorrent ID: \`${torrentId}\``, {
      parse_mode: "Markdown",
    });
    logger.info({ torrentId }, "Magnet added");
  } catch (err) {
    logger.error(err, "Failed to add magnet");
    await ctx.reply("加入磁力鏈結失敗。");
  }
}
