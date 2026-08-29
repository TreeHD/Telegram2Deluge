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

export interface UploadProgress {
  uploaded: number;
  total: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
}

export async function uploadToTelegram(
  api: Api,
  chatId: number,
  filePath: string,
  replyToMessageId?: number,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult> {
  const filename = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const sizeMb = (fileSize / 1024 / 1024).toFixed(0);

  logger.info({ filename, sizeMb }, "Uploading to Telegram (local path)");

  const opts: any = {
    caption: `${filename} (${sizeMb} MB)`,
  };

  if (replyToMessageId) {
    opts.reply_to_message_id = replyToMessageId;
  }

  const msg = await withRetry(async () => {
    let uploaded = 0;
    const startedAt = Date.now();
    let lastProgressAt = 0;
    const stream = fs.createReadStream(filePath);
    const countedStream = (async function* () {
      for await (const chunk of stream) {
        uploaded += chunk.length;
        const now = Date.now();
        if (onProgress && (now - lastProgressAt >= 1000 || uploaded === fileSize)) {
          lastProgressAt = now;
          const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
          const speed = uploaded / elapsedSeconds;
          onProgress({
            uploaded,
            total: fileSize,
            speedBytesPerSecond: speed,
            etaSeconds: speed > 0 ? (fileSize - uploaded) / speed : null,
          });
        }
        yield chunk;
      }
    })();
    const inputFile = new InputFile(countedStream, filename);
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
