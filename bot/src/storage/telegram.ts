import { Api, InputFile } from "grammy";
import { logger } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import { isVideoFile } from "../pipeline/utils.js";

export async function uploadToTelegram(
  api: Api,
  chatId: number,
  filePath: string,
  replyToMessageId?: number
): Promise<void> {
  const filename = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const sizeMb = (fileSize / 1024 / 1024).toFixed(0);

  logger.info({ filename, sizeMb }, "Uploading to Telegram (local path)");

  // Local Bot API server: pass absolute path as string, server reads directly from disk
  // Zero memory usage in bot process
  const inputFile = new InputFile(filePath, filename);

  const opts: any = {
    caption: `${filename} (${sizeMb} MB)`,
  };

  if (replyToMessageId) {
    opts.reply_to_message_id = replyToMessageId;
  }

  if (isVideoFile(filePath)) {
    opts.supports_streaming = true;
    await api.sendVideo(chatId, inputFile, opts);
  } else {
    await api.sendDocument(chatId, inputFile, opts);
  }

  logger.info({ filename }, "Uploaded to Telegram");
}
