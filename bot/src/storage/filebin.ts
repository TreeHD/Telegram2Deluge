import fs from "node:fs";
import path from "node:path";
import { logger } from "../config.js";
import { withRetry } from "../utils/retry.js";

const FILEBIN_BASE = "https://filebin.net";

export interface FilebinUploadResult {
  filename: string;
  url: string;
}

export async function uploadToFilebin(
  filePath: string,
  binId: string
): Promise<FilebinUploadResult | null> {
  const filename = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const url = `${FILEBIN_BASE}/${binId}/${encodeURIComponent(filename)}`;

  logger.info({ filename, binId, sizeMb: (fileSize / 1024 / 1024).toFixed(0) }, "Uploading to Filebin");

  const body = fs.readFileSync(filePath);

  const res = await withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Length": String(fileSize),
      },
      body,
    });

    if (response.status === 403) {
      const text = await response.text();
      logger.warn({ filename, status: 403, text }, "Filebin rejected file (forbidden extension)");
      return response;
    }

    if (!response.ok) {
      throw new Error(`Filebin upload failed: HTTP ${response.status} ${await response.text()}`);
    }

    return response;
  }, `filebin:${filename}`);

  if (res.status === 403) {
    return null;
  }

  const downloadUrl = `${FILEBIN_BASE}/${binId}/${encodeURIComponent(filename)}`;
  logger.info({ filename, binId, downloadUrl }, "Uploaded to Filebin");
  return { filename, url: downloadUrl };
}

export function getFilebinBinUrl(binId: string): string {
  return `${FILEBIN_BASE}/${binId}`;
}
