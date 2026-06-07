import { pino } from "pino";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  telegramApiId: required("TELEGRAM_API_ID"),
  telegramApiHash: required("TELEGRAM_API_HASH"),
  telegramApiRoot: optional("TELEGRAM_API_ROOT", "http://localhost:8081"),
  allowedUserIds: required("ALLOWED_USER_IDS")
    .split(",")
    .map((id) => parseInt(id.trim(), 10)),
  allowedChatIds: (process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .filter((s) => s.trim())
    .map((id) => parseInt(id.trim(), 10)),

  uploadChatId: parseInt(optional("UPLOAD_CHAT_ID", "0"), 10),

  qb: {
    host: optional("QB_HOST", "localhost"),
    port: parseInt(optional("QB_PORT", "8080"), 10),
    username: optional("QB_USERNAME", "admin"),
    password: required("QB_PASSWORD"),
  },

  r2: {
    accountId: required("R2_ACCOUNT_ID"),
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    bucketName: required("R2_BUCKET_NAME"),
    publicUrl: optional("R2_PUBLIC_URL", ""),
  },

  paths: {
    downloads: optional("DOWNLOAD_DIR", "/downloads"),
    processing: optional("PROCESSING_DIR", "/processing"),
    queue: optional("QUEUE_DIR", "/data/queue"),
  },

  cleanup: {
    maxAgeHours: parseInt(optional("CLEANUP_MAX_AGE_HOURS", "24"), 10),
    intervalMinutes: parseInt(optional("CLEANUP_INTERVAL_MINUTES", "5"), 10),
  },

  split: {
    targetSizeMb: parseInt(optional("SPLIT_TARGET_SIZE_MB", "1950"), 10),
  },

  ffmpeg: {
    preset: optional("FFMPEG_PRESET", "medium"),
  },

  streamHost: optional("STREAM_HOST", ""),
} as const;

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});
