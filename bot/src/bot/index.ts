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
import { handleList } from "./handlers/list.js";
import { escapeHtml } from "../utils/html.js";
import { withRetry } from "../utils/retry.js";

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
      apiRoot: config.telegramApiRoot,
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
        "指令:\n/status - 查看下載進度\n/list - 查看所有任務及檔案連結\n/disk - 查看磁碟空間"
    )
  );

  bot.command("status", handleStatus);
  bot.command("disk", handleDisk);
  bot.command("list", handleList);

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.callbackQuery.message!.chat.id;

    try {
      if (data.startsWith("r2_yes:")) {
        const jobId = data.slice(7);
        await ctx.answerCallbackQuery({ text: "開始上傳到 R2，完成後會通知你" });

        // Fire and forget — don't block the bot
        runInBackground(async () => {
          const urls = await ctx.pipeline.uploadToR2ForJob(jobId);
          if (urls.length > 0) {
            const urlList = urls.join("\n");
            await sendMessage(bot.api, chatId, `R2 下載連結 (24hr):\n${urlList}`);
          } else {
            await sendMessage(bot.api, chatId, "找不到待上傳的檔案。");
          }
        }, "r2_upload");

      } else if (data.startsWith("fb_yes:")) {
        const jobId = data.slice(7);
        await ctx.answerCallbackQuery({ text: "開始上傳到 Filebin，完成後會通知你" });

        runInBackground(async () => {
          const { links, skipped, binUrl } = await ctx.pipeline.uploadToFilebinForJob(jobId);
          let text = "";
          if (links.length > 0) {
            text += `Filebin 下載連結:\n${links.join("\n")}`;
            text += `\n\n📁 <a href="${escapeHtml(binUrl)}">開啟 Bin</a>`;
          }
          if (skipped.length > 0) {
            text += `\n\n⚠️ 被拒絕的檔案: ${skipped.map(f => escapeHtml(f)).join(", ")}`;
          }
          if (!text) {
            text = "沒有檔案可上傳。";
          }

          const keyboard = new InlineKeyboard().text("🗑️ 刪除原始檔", `del:${jobId}`);
          await withRetry(async () => {
            await bot.api.sendMessage(chatId, text, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              reply_markup: keyboard,
            } as any);
          }, "fb_result");
        }, "filebin_upload");

      } else if (data.startsWith("noop:")) {
        await ctx.answerCallbackQuery({ text: "上傳中，請稍候..." });
      } else if (data.startsWith("del:")) {
        const jobId = data.slice(4);
        await ctx.pipeline.deleteJobAndTorrent(jobId, ctx.qb);
        await ctx.answerCallbackQuery({ text: "已刪除" });
        const currentText = ctx.callbackQuery.message?.text || "";
        await ctx.editMessageText(
          `${escapeHtml(currentText)}\n\n🗑️ 已刪除原始檔案及 qBittorrent 任務。`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
      } else if (data.startsWith("cancel:")) {
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
    } catch (err) {
      logger.error(err, "Callback query handler error");
      try {
        await ctx.answerCallbackQuery({ text: "操作失敗，請查看 log" });
      } catch {}
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

function runInBackground(fn: () => Promise<void>, label: string) {
  fn().catch((err) => {
    logger.error(err, `Background task failed: ${label}`);
  });
}

async function sendMessage(api: any, chatId: number, text: string) {
  await withRetry(async () => {
    await api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }, "sendMessage");
}
