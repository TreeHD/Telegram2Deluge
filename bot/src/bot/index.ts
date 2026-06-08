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
import { getJobById, removeTrackedTorrent, getStreamFiles } from "../db/index.js";
import { generateStreamUrl } from "../stream/index.js";
import fs from "node:fs";
import path from "node:path";

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

      } else if (data.startsWith("st_yes:")) {
        const jobId = data.slice(7);
        await ctx.answerCallbackQuery({ text: "產生直鏈中..." });

        runInBackground(async () => {
          const files = getStreamFiles(jobId);
          if (files.length === 0) {
            await sendMessage(bot.api, chatId, "找不到待串流的檔案。");
            return;
          }

          const fileLinks = files.map((f) => {
            const url = generateStreamUrl(f.chat_id, f.message_id, f.filename);
            return `<a href="${escapeHtml(url)}">${escapeHtml(f.filename)}</a>`;
          });

          let text = `Stream 直鏈:\n${fileLinks.join("\n")}`;

          // m3u8 if multiple videos
          const videoExts = new Set([".mp4", ".mkv", ".m4v", ".ts", ".avi", ".mov", ".webm"]);
          const videos = files.filter((f) => videoExts.has(path.extname(f.filename).toLowerCase()));
          if (videos.length > 1) {
            const m3u8Lines = ["#EXTM3U"];
            for (const v of videos) {
              const url = generateStreamUrl(v.chat_id, v.message_id, v.filename);
              m3u8Lines.push(`#EXTINF:-1,${v.filename}`);
              m3u8Lines.push(url);
            }
            const m3u8Content = m3u8Lines.join("\n") + "\n";
            const m3u8Buf = Buffer.from(m3u8Content, "utf-8");
            const { InputFile } = await import("grammy");
            await bot.api.sendDocument(chatId, new InputFile(m3u8Buf, "playlist.m3u8"));
          }

          const keyboard = new InlineKeyboard().text("🗑️ 刪除原始檔", `del:${jobId}`);
          await withRetry(async () => {
            await bot.api.sendMessage(chatId, text, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              reply_markup: keyboard,
            } as any);
          }, "stream_result");
        }, "stream_links");

      } else if (data.startsWith("noop:")) {
        await ctx.answerCallbackQuery({ text: "上傳中，請稍候..." });
      } else if (data.startsWith("del:")) {
        const jobId = data.slice(4);
        await ctx.pipeline.deleteJobAndTorrent(jobId, ctx.qb);
        await ctx.answerCallbackQuery({ text: "已刪除原始檔案及 qBittorrent 任務" });
        try {
          await ctx.deleteMessage();
        } catch {}
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
      } else if (data.startsWith("info:")) {
        const hash = data.slice(5);
        await ctx.answerCallbackQuery();
        const torrent = await ctx.qb.getTorrentInfo(hash);
        if (torrent) {
          const progress = Math.floor(torrent.progress * 100);
          const speed = (torrent.dlspeed / 1024 / 1024).toFixed(2);
          const uploaded = (torrent.uploaded / 1024 / 1024 / 1024).toFixed(2);
          const size = (torrent.size / 1024 / 1024 / 1024).toFixed(2);
          const eta = torrent.eta > 0 && torrent.eta < 8640000 ? formatEta(torrent.eta) : "N/A";
          const text =
            `<b>${escapeHtml(torrent.name)}</b>\n\n` +
            `進度: ${progress}% | 狀態: ${torrent.state}\n` +
            `大小: ${size} GB | 已上傳: ${uploaded} GB\n` +
            `速度: ${speed} MB/s | ETA: ${eta}\n` +
            `Hash: <code>${hash}</code>`;
          await withRetry(async () => {
            await bot.api.sendMessage(chatId, text, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            });
          }, "info:torrent");
        } else {
          removeTrackedTorrent(hash);
          await withRetry(async () => {
            await bot.api.sendMessage(chatId, "找不到此下載任務，已從列表移除。");
          }, "info:notfound");
        }
      } else if (data.startsWith("info_job:")) {
        const jobId = data.slice(9);
        await ctx.answerCallbackQuery();
        const pending = ctx.pipeline.getPendingR2(jobId);
        if (pending) {
          const job = getJobById(jobId);
          const files: string[] = JSON.parse(pending.files);
          const existingFiles = files.filter((f) => fs.existsSync(f));
          const name = job?.name || jobId;
          const fileList = existingFiles.map((f) => `• ${escapeHtml(path.basename(f))}`).slice(0, 20);
          const keyboard = new InlineKeyboard()
            .text("上傳 R2", `r2_yes:${jobId}`)
            .text("上傳 Filebin", `fb_yes:${jobId}`);
          if (config.streamHost) {
            keyboard.text("Stream 直鏈", `st_yes:${jobId}`);
          }
          keyboard.row().text("🗑️ 刪除原始檔", `del:${jobId}`);
          const text =
            `<b>${escapeHtml(name.slice(0, 100))}</b>\n\n` +
            `檔案 (${existingFiles.length}):\n${fileList.join("\n")}` +
            (existingFiles.length > 20 ? `\n... +${existingFiles.length - 20}` : "");
          await withRetry(async () => {
            await bot.api.sendMessage(chatId, text, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              reply_markup: keyboard,
            } as any);
          }, "info_job");
        } else {
          ctx.pipeline.removePendingR2(jobId);
          await withRetry(async () => {
            await bot.api.sendMessage(chatId, "此任務已過期或被刪除，已從列表移除。");
          }, "info_job:notfound");
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

function formatEta(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
