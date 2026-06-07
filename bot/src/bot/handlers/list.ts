import { InlineKeyboard } from "grammy";
import { BotContext } from "../index.js";
import { logger } from "../../config.js";
import { getAllTrackedTorrents, getAllPendingActions, getJobById } from "../../db/index.js";
import { escapeHtml } from "../../utils/html.js";
import fs from "node:fs";
import path from "node:path";

export async function handleList(ctx: BotContext) {
  try {
    const tracked = getAllTrackedTorrents();
    const pendingActions = getAllPendingActions();

    if (tracked.length === 0 && pendingActions.length === 0) {
      await ctx.reply("目前沒有任何下載或待處理檔案。");
      return;
    }

    const keyboard = new InlineKeyboard();

    for (const t of tracked) {
      keyboard.text(`⬇️ ${t.hash.slice(0, 8)} (${t.last_progress}%)`, `info:${t.hash}`).row();
    }

    for (const pending of pendingActions) {
      const files: string[] = JSON.parse(pending.files);
      const existingFiles = files.filter((f) => fs.existsSync(f));
      if (existingFiles.length === 0) continue;

      const job = getJobById(pending.job_id);
      const name = job?.name || pending.job_id;
      const label = `📁 ${name.slice(0, 30)} (${existingFiles.length} 檔)`;
      keyboard.text(label, `info_job:${pending.job_id}`).row();
    }

    await ctx.reply("選擇任務查看詳情：", { reply_markup: keyboard });
  } catch (err) {
    logger.error(err, "Failed to handle /list");
    await ctx.reply("取得列表失敗。");
  }
}
