import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";

export async function handleUrl(ctx: BotContext) {
  const text = ctx.message!.text!.trim();

  await ctx.reply("收到下載連結，正在加入下載...");

  try {
    const torrentId = await ctx.deluge.addTorrentUrl(text, {
      download_location: config.paths.downloads,
    });

    ctx.monitor.track(torrentId, ctx.chat!.id);
    await ctx.reply(`已加入下載佇列\nTorrent ID: \`${torrentId}\``, {
      parse_mode: "Markdown",
    });
    logger.info({ torrentId, url: text }, "URL torrent added");
  } catch (err) {
    logger.error(err, "Failed to add URL torrent");
    await ctx.reply("加入下載連結失敗。");
  }
}
