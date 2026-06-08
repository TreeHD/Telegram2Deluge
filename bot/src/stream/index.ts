import crypto from "node:crypto";
import { config } from "../config.js";

export function generateStreamUrl(messageId: number, filename: string): string {
  const hash = generateHash(messageId, filename);
  const encoded = encodeURIComponent(filename);
  return `${config.streamHost}/stream/${messageId}/${encoded}?hash=${hash}`;
}

function generateHash(messageId: number, filename: string): string {
  const secret = process.env.STREAM_SECRET || "";
  const mac = crypto.createHmac("sha256", secret);
  mac.update(`${messageId}:${filename}`);
  return mac.digest("hex").slice(0, 16);
}
