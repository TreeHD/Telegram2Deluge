import { Bot, Context, InlineKeyboard } from "grammy";
import { config, logger } from "../config.js";
import { QBClient } from "../qb/client.js";
import { DownloadMonitor } from "../monitor/index.js";
import { Pipeline } from "../pipeline/index.js";
import { handleTorrentFile } from "./handlers/torrent.js";
import { handleMagnet } from "./handlers/magnet.js";
import { handleUrl } from "./handlers/url.js";
import { handleStatus } from "./handlers/status.js";
import { handleDisk } from "./handlers/disk.js";
import { escapeHtml } from "../utils/html.js";

export interface BotContext extends Context {
  qb: QBClient;
  monitor: DownloadMonitor;
  pipeline: Pipeline;
}

export interface Services {
  qb: QBClient;
  monitor: DownloadMonitor;
  pipeline?: Pipeline;
}

export function createBot(services: Services) {
  const bot = new Bot<BotContext>(config.botToken, {
    client: {
      apiRoot: "http://localhost:8081",
    },
  });

  bot.use((ctx, next) => {
    ctx.qb = services.qb;
    ctx.monitor = services.monitor;
    ctx.pipeline = services.pipeline!;
    return next();
  });

  bot.use((ctx, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const userAllowed = userId && config.allowedUserIds.includes(userId);
    const chatAllowed = chatId && config.allowedChatIds.includes(chatId);
    if (!userAllowed && !chatAllowed) {
      return;
    }
    return next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      "發送 .torrent 檔案、磁力鏈結或下載連結開始下載。\n\n" +
        "指令:\n/status - 查看下載進度\n/disk - 查看磁碟空間"
    )
  );

  bot.command("status", handleStatus);
  bot.command("disk", handleDisk);

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("r2_yes:")) {
      const jobId = data.slice(7);
      const chatId = ctx.callbackQuery.message!.chat.id;
      const messageId = ctx.callbackQuery.message!.message_id;
      await ctx.answerCallbackQuery({ text: "開始上傳到 R2..." });
      await ctx.editMessageText("上傳到 R2 中...");

      try {
        const urls = await ctx.pipeline.uploadToR2ForJob(jobId, chatId, messageId);
        if (urls.length > 0) {
          const urlList = urls.join("\n");
          await ctx.editMessageText(`R2 下載連結 (24hr):\n${urlList}`, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
        } else {
          await ctx.editMessageText("找不到待上傳的檔案。");
        }
      } catch (err) {
        logger.error(err, "R2 upload failed");
        await ctx.editMessageText("上傳到 R2 失敗。");
      }
    }

    if (data.startsWith("r2_no:")) {
      const jobId = data.slice(6);
      await ctx.answerCallbackQuery({ text: "已跳過 R2 上傳" });
      await ctx.editMessageText("已完成，未上傳到 R2。");
      ctx.pipeline.removePendingR2(jobId);
    }

    if (data.startsWith("del:")) {
      const jobId = data.slice(4);
      await ctx.pipeline.deleteJobAndTorrent(jobId, ctx.qb);
      await ctx.answerCallbackQuery({ text: "已刪除" });
      await ctx.editMessageText("已刪除原始檔案及 qBittorrent 任務。");
    }

    if (data.startsWith("cancel:")) {
      const hash = data.slice(7);
      const tracked = ctx.monitor.getTracked(hash);
      if (tracked) {
        await ctx.monitor.cancelTorrent(hash);
        const currentText = ctx.callbackQuery.message?.text || "";
        const name = currentText.split("\n")[0];
        await ctx.answerCallbackQuery({ text: "已取消下載" });
        await ctx.editMessageText(`<s>${escapeHtml(name)}</s>\n\n已取消`, { parse_mode: "HTML" });
      } else {
        await ctx.answerCallbackQuery({ text: "找不到此下載任務" });
      }
    }
  });

  bot.on("message:document", handleTorrentFile);

  bot.on("message:text", (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("magnet:")) {
      return handleMagnet(ctx);
    }
    if (text.startsWith("http://") || text.startsWith("https://")) {
      return handleUrl(ctx);
    }
  });

  bot.catch((err) => {
    logger.error(err, "Bot error");
  });

  return bot;
}
