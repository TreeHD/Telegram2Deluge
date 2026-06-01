import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";
import { getTrackers } from "../../qb/trackers.js";

export async function handleMagnet(ctx: BotContext) {
  const text = ctx.message!.text!.trim();

  const msg = await ctx.reply("收到磁力鏈結，正在加入下載...");

  try {
    const hash = await ctx.qb.addTorrentMagnet(text, {});

    if (!hash) {
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, "加入磁力鏈結失敗。");
      return;
    }

    const trackers = getTrackers();
    if (trackers.length > 0) {
      await ctx.qb.addTrackers(hash, trackers);
    }

    await ctx.api.editMessageText(
      msg.chat.id,
      msg.message_id,
      `已加入下載佇列\nHash: \`${hash}\`\n進度: 0%`,
      { parse_mode: "Markdown" }
    );

    ctx.monitor.track(hash, msg.chat.id, msg.message_id);
    logger.info({ hash }, "Magnet added");
  } catch (err) {
    logger.error(err, "Failed to add magnet");
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, `加入磁力鏈結失敗: ${err}`);
  }
}
