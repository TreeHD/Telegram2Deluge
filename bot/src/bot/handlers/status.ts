import { InlineKeyboard } from "grammy";
import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";
import { getAllTrackedTorrents, getAllPendingActions, getAllActiveJobs, getJobById, getFailedJobs, getStreamFiles } from "../../db/index.js";
import { escapeHtml } from "../../utils/html.js";
import { generateStreamUrl } from "../../stream/index.js";
import { withRetry } from "../../utils/retry.js";
import fs from "node:fs";
import path from "node:path";

export async function handleStatus(ctx: BotContext) {
  try {
    const tracked = getAllTrackedTorrents();
    const pendingActions = getAllPendingActions();
    const activeJobs = getAllActiveJobs();
    const failedJobs = getFailedJobs();
    const torrents = await ctx.qb.getTorrents();

    // Active downloads (exclude completed/seeding)
    const activeTorrents = torrents.filter((t) =>
      t.progress < 1 || t.state === "error" || t.state === "missingFiles"
    );

    if (activeTorrents.length === 0 && pendingActions.length === 0 && activeJobs.length === 0 && failedJobs.length === 0) {
      await ctx.reply("目前沒有任何下載或待處理任務。");
      return;
    }

    const sections: string[] = [];
    const keyboard = new InlineKeyboard();

    for (const t of activeTorrents) {
      const speed = (t.dlspeed / 1024 / 1024).toFixed(2);
      const progress = (t.progress * 100).toFixed(1);
      const eta = t.eta > 0 && t.eta < 8640000 ? formatEta(t.eta) : "N/A";
      const stateLabel = getStateLabel(t.state);

      sections.push(
        `<b>${escapeHtml(t.name.slice(0, 60))}</b>\n` +
        `${stateLabel} ${progress}% | ${speed} MB/s | ETA: ${eta}`
      );

      keyboard
        .text("ℹ️ 詳情", `info:${t.hash}`)
        .text("❌ 取消", `cancel:${t.hash}`)
        .row();
    }

    // Pipeline jobs (pending/processing)
    for (const job of activeJobs) {
      const statusLabel = job.status === "processing" ? "⚙️ 處理中" : "🕐 排隊中";
      sections.push(
        `<b>${escapeHtml(job.name.slice(0, 60))}</b>\n` +
        `${statusLabel}`
      );
    }

    // Pending actions (upload completed, waiting for user)
    for (const pending of pendingActions) {
      const files: string[] = JSON.parse(pending.files);
      const existingFiles = files.filter((f) => fs.existsSync(f));
      if (existingFiles.length === 0) continue;

      const job = getJobById(pending.job_id);
      const name = job?.name || pending.job_id;

      sections.push(
        `<b>${escapeHtml(name.slice(0, 60))}</b>\n` +
        `📁 ${existingFiles.length} 個檔案待處理`
      );

      keyboard.text("R2", `r2_yes:${pending.job_id}`);
      keyboard.text("Filebin", `fb_yes:${pending.job_id}`);
      if (config.streamHost) {
        keyboard.text("Stream", `st_yes:${pending.job_id}`);
      }
      keyboard.row();
      keyboard.text("📤 重傳", `reup:${pending.job_id}`);
      keyboard.text("🗑️", `del:${pending.job_id}`);
      keyboard.row();
    }

    // Failed jobs — show stream links if available
    for (const job of failedJobs) {
      const streamFiles = getStreamFiles(job.id);
      const fileLinks: string[] = [];

      if (config.streamHost && streamFiles.length > 0) {
        for (const f of streamFiles) {
          const url = generateStreamUrl(f.message_id, f.filename);
          fileLinks.push(`<a href="${escapeHtml(url)}">${escapeHtml(f.filename)}</a>`);
        }
      }

      let text = `<b>${escapeHtml(job.name.slice(0, 60))}</b>\n⚠️ 處理失敗`;
      if (fileLinks.length > 0) {
        text += ` (已上傳 ${fileLinks.length} 檔)\n${fileLinks.join("\n")}`;
      }
      sections.push(text);

      keyboard.text("🔄 重試", `retry:${job.id}`);
      keyboard.text("📤 重傳", `reup:${job.id}`);
      if (config.streamHost && streamFiles.length > 0) {
        keyboard.text("Stream", `st_yes:${job.id}`);
      }
      keyboard.text("🗑️", `del:${job.id}`);
      keyboard.row();
    }

    const text = sections.join("\n\n");
    await withRetry(async () => {
      await ctx.reply(text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      } as any);
    }, "status");
  } catch (err) {
    logger.error(err, "Failed to get status");
    await ctx.reply("取得狀態失敗。");
  }
}

function formatEta(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getStateLabel(state: string): string {
  switch (state) {
    case "downloading": return "⬇️";
    case "uploading":
    case "forcedUP": return "⬆️";
    case "stalledDL": return "⏳";
    case "pausedDL": return "⏸️";
    case "queuedDL": return "🕐";
    case "checkingDL":
    case "checkingUP": return "🔍";
    case "error":
    case "missingFiles": return "⚠️";
    default: return "📦";
  }
}
