import { BotContext } from "../index.js";
import { logger } from "../../config.js";
import { getAllTrackedTorrents, getAllPendingActions, getJobById } from "../../db/index.js";
import { buildMessageLink } from "../../storage/telegram.js";
import { escapeHtml } from "../../utils/html.js";
import fs from "node:fs";
import path from "node:path";

export async function handleList(ctx: BotContext) {
  try {
    const sections: string[] = [];

    // 1. Active downloads
    const tracked = getAllTrackedTorrents();
    if (tracked.length > 0) {
      const lines = tracked.map((t) => {
        const msgLink = buildMessageLink(t.chat_id, t.message_id);
        return `⬇️ <a href="${msgLink}">下載中 (${t.last_progress}%)</a> - ${escapeHtml(t.hash.slice(0, 8))}`;
      });
      sections.push(`<b>下載中:</b>\n${lines.join("\n")}`);
    }

    // 2. Completed jobs with files still on disk
    const pendingActions = getAllPendingActions();
    const validPending: string[] = [];

    for (const pending of pendingActions) {
      const files: string[] = JSON.parse(pending.files);
      const existingFiles = files.filter((f) => fs.existsSync(f));
      if (existingFiles.length === 0) continue;

      const job = getJobById(pending.job_id);
      const name = job?.name || pending.job_id;
      const msgLink = job ? buildMessageLink(pending.chat_id, job.message_id) : "";

      const fileList = existingFiles.map((f) => path.basename(f)).slice(0, 3);
      const display = fileList.join(", ") + (existingFiles.length > 3 ? ` +${existingFiles.length - 3}` : "");

      if (msgLink) {
        validPending.push(`📁 <a href="${msgLink}">${escapeHtml(name.slice(0, 50))}</a>\n   ${escapeHtml(display)}`);
      } else {
        validPending.push(`📁 ${escapeHtml(name.slice(0, 50))}\n   ${escapeHtml(display)}`);
      }
    }

    if (validPending.length > 0) {
      sections.push(`<b>已完成 (待處理):</b>\n${validPending.join("\n\n")}`);
    }

    if (sections.length === 0) {
      await ctx.reply("目前沒有任何下載或待處理檔案。");
      return;
    }

    await ctx.reply(sections.join("\n\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    logger.error(err, "Failed to handle /list");
    await ctx.reply("取得列表失敗。");
  }
}
