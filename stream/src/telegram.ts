const BOT_TOKEN = process.env.BOT_TOKEN!;
const TELEGRAM_API_ROOT = process.env.TELEGRAM_API_ROOT || "http://telegram-bot-api:8081";

export interface TgFileInfo {
  filePath: string;
  fileSize: number;
}

export async function resolveFile(fileId: string): Promise<TgFileInfo | null> {
  const url = `${TELEGRAM_API_ROOT}/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  if (!data.ok || !data.result?.file_path) return null;
  return {
    filePath: data.result.file_path,
    fileSize: data.result.file_size || 0,
  };
}

export function getFileUrl(filePath: string): string {
  return `${TELEGRAM_API_ROOT}/file/bot${BOT_TOKEN}/${filePath}`;
}
