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

    try {
      if (data.startsWith("r2_yes:")) {
        const jobId = data.slice(7);
        const chatId = ctx.callbackQuery.message!.chat.id;
        const messageId = ctx.callbackQuery.message!.message_id;
        await ctx.answerCallbackQuery({ text: "開始上傳到 R2..." });
        await ctx.editMessageText("上傳到 R2 中...");

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
      } else if (data.startsWith("r2_no:")) {
        const jobId = data.slice(6);
        await ctx.answerCallbackQuery({ text: "已跳過 R2 上傳" });
        await ctx.editMessageText("已完成，未上傳到 R2。");
        ctx.pipeline.removePendingR2(jobId);
      } else if (data.startsWith("fb_yes:")) {
        const jobId = data.slice(7);
        await ctx.answerCallbackQuery({ text: "開始上傳到 Filebin..." });
        await ctx.editMessageText("上傳到 Filebin 中...");

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
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        });
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
      try {
        const chatId = ctx.callbackQuery.message?.chat.id;
        const msgId = ctx.callbackQuery.message?.message_id;
        if (chatId && msgId) {
          await ctx.api.editMessageText(chatId, msgId, `操作失敗: ${err}`);
        }
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
