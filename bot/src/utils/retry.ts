import { Api } from "grammy";
import { logger } from "../config.js";

const MAX_RETRIES = 5;

export async function withRetry<T>(fn: () => Promise<T>, label = "Telegram API"): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err: any) {
      const retryAfter = extractRetryAfter(err);

      if (retryAfter) {
        logger.warn({ retryAfter, attempt, label }, "Rate limited, waiting...");
        await sleep((retryAfter + 1) * 1000);
        continue;
      }

      if (attempt < MAX_RETRIES && isRetryable(err)) {
        logger.warn({ attempt, label }, "Retryable error, retrying in 3s...");
        await sleep(3000);
        continue;
      }

      throw err;
    }
  }
}

function extractRetryAfter(err: any): number | null {
  // grammY rate limit in parameters
  if (err?.parameters?.retry_after) {
    return err.parameters.retry_after;
  }
  // "retry after N" in description
  const match = err?.description?.match(/retry after (\d+)/i) ||
    err?.message?.match(/retry after (\d+)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

function isRetryable(err: any): boolean {
  const code = err?.error_code || err?.status;
  // 429, 500, 502, 503, 504 are retryable
  if (code && (code === 429 || code >= 500)) return true;
  // "too Many Requests" in 400 response
  if (err?.description?.includes("Too Many Requests") || err?.description?.includes("too Many Requests")) return true;
  // Network errors
  if (err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT" || err?.code === "ECONNREFUSED") return true;
  // grammY HttpError (network failure during upload)
  if (err?.constructor?.name === "HttpError" || err?.message?.includes("Network request")) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
