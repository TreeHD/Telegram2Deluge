import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";
import { getTrackers } from "../../qb/trackers.js";
import fs from "node:fs";

export async function handleTorrentFile(ctx: BotContext) {
  const doc = ctx.message?.document;
  if (!doc || !doc.file_name?.endsWith(".torrent")) {
    return;
  }

  await ctx.reply(`收到種子檔: ${doc.file_name}，正在加入下載...`);

  try {
    const file = await ctx.getFile();
    const filePath = file.file_path!;

    let buffer: Buffer;
    if (filePath.startsWith("/")) {
      buffer = fs.readFileSync(filePath);
    } else {
      const response = await fetch(
        `http://localhost:8081/file/bot${config.botToken}/${filePath}`
      );
      buffer = Buffer.from(await response.arrayBuffer());
    }

    const hash = await ctx.qb.addTorrentFile(buffer, doc.file_name, {
      savepath: config.paths.downloads,
    });

    if (!hash) {
      await ctx.reply("qBittorrent 無法解析此種子檔案。");
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
    logger.info({ hash, filename: doc.file_name }, "Torrent added");
  } catch (err) {
    logger.error(err, "Failed to add torrent file");
    await ctx.reply(`加入種子失敗: ${err}`);
  }
}
