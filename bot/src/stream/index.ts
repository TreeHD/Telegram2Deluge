import crypto from "node:crypto";
import { config } from "../config.js";

export function generateStreamUrl(chatId: number, messageId: number, filename: string): string {
  const hash = generateHash(chatId, messageId, filename);
  const encoded = encodeURIComponent(filename);
  return `${config.streamHost}/stream/${chatId}/${messageId}/${encoded}?hash=${hash}`;
}

function generateHash(chatId: number, messageId: number, filename: string): string {
  const secret = process.env.STREAM_SECRET || "";
  const mac = crypto.createHmac("sha256", secret);
  mac.update(`${chatId}:${messageId}:${filename}`);
  return mac.digest("hex").slice(0, 16);
}
