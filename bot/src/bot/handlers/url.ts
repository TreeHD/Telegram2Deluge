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
      await addTorrentFromUrl(ctx, text);
    } else {
      await downloadDirectUrl(ctx, text);
    }
  } catch (err) {
    logger.error(err, "Failed to handle URL");
    try {
      await ctx.reply(`處理連結失敗: ${err}`);
    } catch {}
  }
}

async function addTorrentFromUrl(ctx: BotContext, url: string) {
  const msg = await ctx.reply("收到 torrent 連結，正在加入下載...");

  try {
    const response = await fetch(url);
    if (!response.ok) {
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, `下載 torrent 檔案失敗: HTTP ${response.status}`);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = path.basename(new URL(url).pathname) || "download.torrent";

    const hash = await ctx.qb.addTorrentFile(buffer, filename, {});

    if (!hash) {
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, "qBittorrent 無法解析此 torrent 檔案。");
      return;
    }

    const trackers = getTrackers();
    if (trackers.length > 0) {
      try {
        await ctx.qb.addTrackers(hash, trackers);
      } catch (err) {
        logger.error(err, "Failed to add trackers");
      }
    }

    await ctx.api.editMessageText(
      msg.chat.id,
      msg.message_id,
      `已加入下載佇列\nHash: \`${hash}\`\n進度: 0%`,
      { parse_mode: "Markdown" }
    );

    ctx.monitor.track(hash, msg.chat.id, msg.message_id);
    logger.info({ hash, url }, "Torrent URL added");
  } catch (err) {
    logger.error(err, "Failed to add torrent from URL");
    try {
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, `加入 torrent 失敗: ${err}`);
    } catch {}
  }
}

async function downloadDirectUrl(ctx: BotContext, url: string) {
  const msg = await ctx.reply("收到檔案連結，正在直接下載...");

  try {
    const response = await fetch(url);
    if (!response.ok) {
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, `下載失敗: HTTP ${response.status}`);
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

    await ctx.api.editMessageText(msg.chat.id, msg.message_id, `下載完成: ${filename} (${sizeMb} MB)`);
    logger.info({ filename, sizeMb, url }, "Direct URL download complete");

    ctx.pipeline.enqueue({
      torrentId: `direct-${Date.now()}`,
      chatId: msg.chat.id,
      messageId: msg.message_id,
      name: filename,
      savePath: config.paths.downloads,
      files: [{ path: filename, size: fileSize }],
      totalSize: fileSize,
    });
  } catch (err) {
    logger.error(err, "Failed to download direct URL");
    try {
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, `下載失敗: ${err}`);
    } catch {}
  }
}
