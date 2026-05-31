import { BotContext } from "../index.js";
import { logger } from "../../config.js";

export async function handleStatus(ctx: BotContext) {
  try {
    const torrents = await ctx.qb.getTorrents();

    if (torrents.length === 0) {
      await ctx.reply("目前沒有任何下載任務。");
      return;
    }

    const lines = torrents.map((t) => {
      const speed = (t.dlspeed / 1024 / 1024).toFixed(2);
      const eta = t.eta > 0 && t.eta < 8640000 ? formatEta(t.eta) : "N/A";
      const progress = (t.progress * 100).toFixed(1);
      return (
        `📦 ${t.name}\n` +
        `   進度: ${progress}% | 狀態: ${t.state}\n` +
        `   速度: ${speed} MB/s | ETA: ${eta}`
      );
    });

    await ctx.reply(lines.join("\n\n"));
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
