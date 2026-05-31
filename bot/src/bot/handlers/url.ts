import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";
import { getTrackers } from "../../qb/trackers.js";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export async function handleUrl(ctx: BotContext) {
  const text = ctx.message!.text!.trim();

  try {
    const url = new URL(text);
    const isTorrentUrl = url.pathname.endsWith(".torrent");

    if (isTorrentUrl) {
      await ctx.reply("收到 torrent 連結，正在加入下載...");
      await addTorrentFromUrl(ctx, text);
    } else {
      await ctx.reply("收到檔案連結，正在直接下載...");
      await downloadDirectUrl(ctx, text);
    }
  } catch (err) {
    logger.error(err, "Failed to handle URL");
    await ctx.reply(`處理連結失敗: ${err}`);
  }
}

async function addTorrentFromUrl(ctx: BotContext, url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    await ctx.reply(`下載 torrent 檔案失敗: HTTP ${response.status}`);
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = path.basename(new URL(url).pathname) || "download.torrent";

  const hash = await ctx.qb.addTorrentFile(buffer, filename, {
    savepath: config.paths.downloads,
  });

  if (!hash) {
    await ctx.reply("qBittorrent 無法解析此 torrent 檔案。");
    return;
  }

  const trackers = getTrackers();
  if (trackers.length > 0) {
    await ctx.qb.addTrackers(hash, trackers);
  }

  ctx.monitor.track(hash, ctx.chat!.id);
  await ctx.reply(`已加入下載佇列\nHash: \`${hash}\``, {
    parse_mode: "Markdown",
  });
  logger.info({ hash, url }, "Torrent URL added");
}

async function downloadDirectUrl(ctx: BotContext, url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    await ctx.reply(`下載失敗: HTTP ${response.status}`);
    return;
  }

  const contentDisposition = response.headers.get("content-disposition");
  let filename = path.basename(new URL(url).pathname) || "download";
  if (contentDisposition) {
    const match = contentDisposition.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)/i);
    if (match) filename = decodeURIComponent(match[1].replace(/"/g, ""));
  }

  const destPath = path.join(config.paths.downloads, filename);
  const fileStream = fs.createWriteStream(destPath);

  await pipeline(
    Readable.fromWeb(response.body! as any),
    fileStream
  );

  const fileSize = fs.statSync(destPath).size;
  const sizeMb = (fileSize / 1024 / 1024).toFixed(1);

  await ctx.reply(`下載完成: ${filename} (${sizeMb} MB)`);
  logger.info({ filename, sizeMb, url }, "Direct URL download complete");

  ctx.pipeline.enqueue({
    torrentId: `direct-${Date.now()}`,
    chatId: ctx.chat!.id,
    name: filename,
    savePath: config.paths.downloads,
    files: [{ path: destPath, size: fileSize }],
    totalSize: fileSize,
  });
}
