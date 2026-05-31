import { Bot, Context } from "grammy";
import { config, logger } from "../config.js";
import { DelugeClient } from "../deluge/client.js";
import { DownloadMonitor } from "../monitor/index.js";
import { Pipeline } from "../pipeline/index.js";
import { handleTorrentFile } from "./handlers/torrent.js";
import { handleMagnet } from "./handlers/magnet.js";
import { handleUrl } from "./handlers/url.js";
import { handleStatus } from "./handlers/status.js";
import { handleDisk } from "./handlers/disk.js";

export interface BotContext extends Context {
  deluge: DelugeClient;
  monitor: DownloadMonitor;
  pipeline: Pipeline;
}

export interface Services {
  deluge: DelugeClient;
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
    ctx.deluge = services.deluge;
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
      await ctx.answerCallbackQuery({ text: "開始上傳到 R2..." });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });

      try {
        const urls = await ctx.pipeline.uploadToR2ForJob(jobId);
        if (urls.length > 0) {
          const urlList = urls.map((u, i) => `${i + 1}. ${u}`).join("\n");
          await ctx.reply(`R2 下載連結 (24hr):\n${urlList}`, {
            reply_to_message_id: ctx.callbackQuery.message?.message_id,
          });
        } else {
          await ctx.reply("找不到待上傳的檔案。");
        }
      } catch (err) {
        logger.error(err, "R2 upload failed");
        await ctx.reply("上傳到 R2 失敗。");
      }
    }

    if (data.startsWith("r2_no:")) {
      const jobId = data.slice(6);
      await ctx.answerCallbackQuery({ text: "已跳過 R2 上傳" });
      await ctx.editMessageText("已完成，未上傳到 R2。");
      const pending = ctx.pipeline.getPendingR2(jobId);
      if (pending) {
        ctx.pipeline.removePendingR2(jobId);
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
