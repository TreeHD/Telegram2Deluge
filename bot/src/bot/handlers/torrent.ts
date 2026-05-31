import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";
import path from "node:path";

export async function handleTorrentFile(ctx: BotContext) {
  const doc = ctx.message?.document;
  if (!doc || !doc.file_name?.endsWith(".torrent")) {
    return;
  }

  await ctx.reply(`收到種子檔: ${doc.file_name}，正在加入下載...`);

  try {
    const file = await ctx.getFile();
    const filePath = file.file_path!;
    const response = await fetch(
      `http://telegram-bot-api:8081/file/bot${config.botToken}/${filePath}`
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    const b64 = buffer.toString("base64");

    const torrentId = await ctx.deluge.addTorrentFile(
      doc.file_name,
      b64,
      { download_location: config.paths.downloads }
    );

    ctx.monitor.track(torrentId, ctx.chat!.id);
    await ctx.reply(`已加入下載佇列\nTorrent ID: \`${torrentId}\``, {
      parse_mode: "Markdown",
    });
    logger.info({ torrentId, filename: doc.file_name }, "Torrent added");
  } catch (err) {
    logger.error(err, "Failed to add torrent file");
    await ctx.reply("加入種子失敗，請檢查檔案是否正確。");
  }
}
