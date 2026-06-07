import { Api, InputFile } from "grammy";
import { logger } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import { isVideoFile } from "../pipeline/utils.js";
import { withRetry } from "../utils/retry.js";

export interface UploadResult {
  messageId: number;
  chatId: number;
  fileId: string;
}

export async function uploadToTelegram(
  api: Api,
  chatId: number,
  filePath: string,
  replyToMessageId?: number
): Promise<UploadResult> {
  const filename = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const sizeMb = (fileSize / 1024 / 1024).toFixed(0);

  logger.info({ filename, sizeMb }, "Uploading to Telegram (local path)");

  const inputFile = new InputFile(filePath, filename);

  const opts: any = {
    caption: `${filename} (${sizeMb} MB)`,
  };

  if (replyToMessageId) {
    opts.reply_to_message_id = replyToMessageId;
  }

  const msg = await withRetry(async () => {
    if (isVideoFile(filePath)) {
      opts.supports_streaming = true;
      return api.sendVideo(chatId, inputFile, opts);
    } else {
      return api.sendDocument(chatId, inputFile, opts);
    }
  }, `uploadToTelegram:${filename}`);

  let fileId = "";
  const m = msg as any;
  if (m.video) {
    fileId = m.video.file_id;
  } else if (m.document) {
    fileId = m.document.file_id;
  }

  logger.info({ filename, messageId: msg.message_id, fileId }, "Uploaded to Telegram");
  return { messageId: msg.message_id, chatId, fileId };
}

// Build a t.me link for a message in a private supergroup/channel.
// Private supergroup chat IDs look like -100XXXXXXXXXX; strip the -100 prefix.
export function buildMessageLink(chatId: number, messageId: number): string {
  const idStr = String(chatId);
  const stripped = idStr.startsWith("-100") ? idStr.slice(4) : idStr.replace("-", "");
  return `https://t.me/c/${stripped}/${messageId}`;
}
