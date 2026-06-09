import path from "node:path";
import { isVideoFile } from "../pipeline/utils.js";

const PLAYLIST_EXTENSIONS = new Set([".mp4", ".mkv", ".m4v", ".ts", ".avi", ".mov", ".webm"]);

function isPlaylistVideo(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return PLAYLIST_EXTENSIONS.has(ext);
}

export function generateM3u8(files: Array<{ filename: string; url: string }>): string | null {
  const videos = files.filter((f) => isPlaylistVideo(f.filename));
  if (videos.length <= 1) return null;

  videos.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));

  const lines = ["#EXTM3U"];
  for (const video of videos) {
    lines.push(`#EXTINF:-1,${video.filename}`);
    lines.push(video.url);
  }

  return lines.join("\n") + "\n";
}
