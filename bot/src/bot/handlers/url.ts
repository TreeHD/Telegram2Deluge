import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";

export async function handleUrl(ctx: BotContext) {
  const text = ctx.message!.text!.trim();

  await ctx.reply("收到下載連結，正在加入下載...");

  try {
    logger.info({ url: text }, "Adding URL torrent");
    const torrentId = await ctx.deluge.addTorrentUrl(text, {
      download_location: config.paths.downloads,
    });

    logger.info({ torrentId, url: text }, "addTorrentUrl response");

    if (!torrentId) {
      await ctx.reply("加入失敗：Deluge 無法解析此連結。可能不是有效的 torrent URL。");
      return;
    }

    ctx.monitor.track(torrentId, ctx.chat!.id);
    await ctx.reply(`已加入下載佇列\nTorrent ID: \`${torrentId}\``, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    logger.error(err, "Failed to add URL torrent");
    await ctx.reply(`加入下載連結失敗: ${err}`);
  }
}
