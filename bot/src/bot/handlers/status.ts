import { InlineKeyboard } from "grammy";
import { BotContext } from "../index.js";
import { config, logger } from "../../config.js";
import { getAllPendingActions, getAllActiveJobs, getJobById, getFailedJobs, getStreamFiles, getPendingAction } from "../../db/index.js";
import { escapeHtml } from "../../utils/html.js";
import { withRetry } from "../../utils/retry.js";
import fs from "node:fs";

export async function handleStatus(ctx: BotContext) {
  try {
    const { text, keyboard } = await buildOverview(ctx);
    if (!text) {
      await ctx.reply("目前沒有任何下載或待處理任務。");
      return;
    }
    await withRetry(async () => {
      await ctx.reply(text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      } as any);
    }, "status");
  } catch (err) {
    logger.error(err, "Failed to send status");
    await ctx.reply("取得狀態失敗。").catch(() => {});
  }
}

export async function handleStatusBack(ctx: BotContext) {
  try {
    const { text, keyboard } = await buildOverview(ctx);
    if (!text) {
      await ctx.editMessageText("目前沒有任何下載或待處理任務。");
      return;
    }
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    } as any);
  } catch (err: any) {
    if (!err?.description?.includes("message is not modified")) {
      logger.error(err, "Failed to edit status back");
    }
  }
}

export async function handleStatusDetail(ctx: BotContext, type: string, id: string) {
  try {
    const { text, keyboard } = await buildDetail(ctx, type, id);
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    } as any);
  } catch (err: any) {
    if (!err?.description?.includes("message is not modified")) {
      logger.error(err, "Failed to show status detail");
    }
  }
}

interface OverviewResult {
  text: string | null;
  keyboard: InlineKeyboard;
}

async function buildOverview(ctx: BotContext): Promise<OverviewResult> {
  const lines: string[] = [];
  const keyboard = new InlineKeyboard();
  let index = 0;

  // Active downloads
  try {
    const torrents = await ctx.qb.getTorrents();
    const activeTorrents = torrents.filter((t) =>
      t.progress < 1 || t.state === "error" || t.state === "missingFiles"
    );

    for (const t of activeTorrents) {
      const progress = (t.progress * 100).toFixed(1);
      const stateLabel = getStateLabel(t.state);
      const speed = (t.dlspeed / 1024 / 1024).toFixed(1);
      lines.push(`${stateLabel} <b>${escapeHtml(t.name.slice(0, 40))}</b> ${progress}% | ${speed} MB/s`);
      keyboard.text(shortLabel(t.name, index), `sd:dl:${t.hash}`);
      if (index % 2 === 1) keyboard.row();
      index++;
    }
  } catch (err) {
    logger.error(err, "Failed to fetch torrents for status");
    lines.push("⚠️ 無法取得下載狀態");
  }

  // Pipeline jobs (pending/processing)
  try {
    const activeJobs = getAllActiveJobs();
    for (const job of activeJobs) {
      const statusLabel = job.status === "processing" ? "⚙️" : "🕐";
      const statusText = job.status === "processing" ? "處理中" : "排隊中";
      lines.push(`${statusLabel} <b>${escapeHtml(job.name.slice(0, 40))}</b> ${statusText}`);
      keyboard.text(shortLabel(job.name, index), `sd:job:${job.id}`);
      if (index % 2 === 1) keyboard.row();
      index++;
    }
  } catch (err) {
    logger.error(err, "Failed to fetch active jobs for status");
    lines.push("⚠️ 無法取得處理中任務");
  }

  // Pending actions
  try {
    const pendingActions = getAllPendingActions();
    for (const pending of pendingActions) {
      const files: string[] = JSON.parse(pending.files);
      const existingFiles = files.filter((f) => fs.existsSync(f));
      if (existingFiles.length === 0) continue;

      const job = getJobById(pending.job_id);
      const name = job?.name || pending.job_id;
      lines.push(`📁 <b>${escapeHtml(name.slice(0, 40))}</b> ${existingFiles.length} 檔待處理`);
      keyboard.text(shortLabel(name, index), `sd:pa:${pending.job_id}`);
      if (index % 2 === 1) keyboard.row();
      index++;
    }
  } catch (err) {
    logger.error(err, "Failed to fetch pending actions for status");
    lines.push("⚠️ 無法取得待處理任務");
  }

  // Failed jobs
  try {
    const failedJobs = getFailedJobs();
    for (const job of failedJobs) {
      lines.push(`⚠️ <b>${escapeHtml(job.name.slice(0, 40))}</b> 失敗`);
      keyboard.text(shortLabel(job.name, index), `sd:fail:${job.id}`);
      if (index % 2 === 1) keyboard.row();
      index++;
    }
  } catch (err) {
    logger.error(err, "Failed to fetch failed jobs for status");
    lines.push("⚠️ 無法取得失敗任務");
  }

  if (index % 2 === 1) keyboard.row();

  if (lines.length === 0) {
    return { text: null, keyboard };
  }

  const text = `📋 <b>任務總覽</b>\n\n${lines.join("\n")}`;
  return { text, keyboard };
}

interface DetailResult {
  text: string;
  keyboard: InlineKeyboard;
}

async function buildDetail(ctx: BotContext, type: string, id: string): Promise<DetailResult> {
  const keyboard = new InlineKeyboard();

  if (type === "dl") {
    const torrent = await ctx.qb.getTorrentInfo(id);
    if (!torrent) {
      keyboard.text("⬅️ 返回列表", "sb:");
      return { text: "找不到此下載任務。", keyboard };
    }
    const progress = (torrent.progress * 100).toFixed(1);
    const speed = (torrent.dlspeed / 1024 / 1024).toFixed(2);
    const size = (torrent.size / 1024 / 1024 / 1024).toFixed(2);
    const eta = torrent.eta > 0 && torrent.eta < 8640000 ? formatEta(torrent.eta) : "N/A";
    const stateLabel = getStateLabel(torrent.state);

    const text =
      `<b>${escapeHtml(torrent.name)}</b>\n\n` +
      `${stateLabel} ${progress}% | ${speed} MB/s | ETA: ${eta}\n` +
      `大小: ${size} GB | 狀態: ${torrent.state}\n` +
      `Hash: <code>${id}</code>`;

    keyboard.text("ℹ️ 詳情", `info:${id}`).text("❌ 取消", `cancel:${id}`).row();
    keyboard.text("⬅️ 返回列表", "sb:");
    return { text, keyboard };
  }

  if (type === "job") {
    const job = getJobById(id);
    if (!job) {
      keyboard.text("⬅️ 返回列表", "sb:");
      return { text: "找不到此任務。", keyboard };
    }
    const activeJobs = getAllActiveJobs();
    const active = activeJobs.find((j) => j.id === id);
    const statusLabel = active?.status === "processing" ? "⚙️ 處理中" : "🕐 排隊中";

    const text =
      `<b>${escapeHtml(job.name)}</b>\n\n` +
      `${statusLabel}`;

    keyboard.text("🔄 重試", `retry:${id}`).text("🗑️ 刪除", `del:${id}`).row();
    keyboard.text("⬅️ 返回列表", "sb:");
    return { text, keyboard };
  }

  if (type === "pa") {
    const pending = getPendingAction(id);
    if (!pending) {
      keyboard.text("⬅️ 返回列表", "sb:");
      return { text: "此任務已過期或被刪除。", keyboard };
    }
    const job = getJobById(id);
    const name = job?.name || id;
    const files: string[] = JSON.parse(pending.files);
    const existingFiles = files.filter((f) => fs.existsSync(f));

    const text =
      `<b>${escapeHtml(name)}</b>\n\n` +
      `📁 ${existingFiles.length} 個檔案待處理`;

    keyboard.text("R2", `r2_yes:${id}`);
    if (config.streamHost) {
      keyboard.text("Stream", `st_yes:${id}`);
    }
    if (config.paths.library) {
      keyboard.text("📂 入庫", `lib:${id}`);
    }
    keyboard.row();
    keyboard.text("📤 重傳", `reup:${id}`).text("🗑️ 刪除", `del:${id}`).row();
    keyboard.text("⬅️ 返回列表", "sb:");
    return { text, keyboard };
  }

  if (type === "fail") {
    const job = getJobById(id);
    if (!job) {
      keyboard.text("⬅️ 返回列表", "sb:");
      return { text: "找不到此任務。", keyboard };
    }

    const streamFiles = getStreamFiles(id);
    let text = `<b>${escapeHtml(job.name)}</b>\n\n⚠️ 處理失敗`;

    if (config.streamHost && streamFiles.length > 0) {
      text += ` (已上傳 ${streamFiles.length} 檔)`;
    }

    keyboard.text("🔄 重試", `retry:${id}`).text("📤 重傳", `reup:${id}`);
    if (config.streamHost && streamFiles.length > 0) {
      keyboard.text("Stream", `st_yes:${id}`);
    }
    keyboard.text("🗑️", `del:${id}`).row();
    keyboard.text("⬅️ 返回列表", "sb:");
    return { text, keyboard };
  }

  keyboard.text("⬅️ 返回列表", "sb:");
  return { text: "未知的任務類型。", keyboard };
}

function shortLabel(name: string, _index: number): string {
  return name.slice(0, 20) || "???";
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
