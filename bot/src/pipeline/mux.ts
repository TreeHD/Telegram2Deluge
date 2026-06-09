import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../config.js";

const execFileAsync = promisify(execFile);

const SUBTITLE_EXTS = new Set([".ass", ".srt", ".ssa"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".m4v"]);

const LANG_MAP: Record<string, { code: string; title: string; priority: number }> = {
  cht: { code: "chi", title: "繁體中文", priority: 0 },
  tc: { code: "chi", title: "繁體中文", priority: 0 },
  tw: { code: "chi", title: "繁體中文", priority: 0 },
  big5: { code: "chi", title: "繁體中文", priority: 0 },
  chs: { code: "chi", title: "简体中文", priority: 1 },
  sc: { code: "chi", title: "简体中文", priority: 1 },
  zh: { code: "chi", title: "中文", priority: 2 },
  jp: { code: "jpn", title: "日本語", priority: 3 },
  ja: { code: "jpn", title: "日本語", priority: 3 },
  en: { code: "eng", title: "English", priority: 4 },
};

export interface MuxResult {
  outputPath: string;
  videoPath: string;
  subtitlePaths: string[];
}

export async function muxSubtitles(
  allFiles: string[],
  outputDir: string
): Promise<MuxResult[]> {
  const videos: string[] = [];
  const subs: string[] = [];

  for (const f of allFiles) {
    const ext = path.extname(f).toLowerCase();
    if (VIDEO_EXTS.has(ext)) {
      videos.push(f);
    } else if (SUBTITLE_EXTS.has(ext)) {
      subs.push(f);
    }
  }

  if (videos.length === 0 || subs.length === 0) return [];

  const results: MuxResult[] = [];

  for (const video of videos) {
    const videoStem = stemOf(video);
    const matched = subs.filter((s) => subStemMatchesVideo(s, videoStem));
    if (matched.length === 0) continue;

    // Sort subtitles: Traditional Chinese first
    matched.sort((a, b) => detectLang(a).priority - detectLang(b).priority);

    try {
      const outputPath = await runMux(video, matched, outputDir);
      results.push({ outputPath, videoPath: video, subtitlePaths: matched });
    } catch (err) {
      logger.error(err, `Failed to mux subtitles for ${path.basename(video)}`);
    }
  }

  return results;
}

function stemOf(filePath: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  return base.slice(0, -ext.length);
}

function subStemMatchesVideo(subPath: string, videoStem: string): boolean {
  const base = path.basename(subPath);
  // Remove subtitle extension (.ass, .srt, .ssa)
  const withoutSubExt = base.slice(0, -path.extname(base).length);
  // Either exact match or starts with video stem + separator
  return withoutSubExt === videoStem || withoutSubExt.startsWith(videoStem + ".");
}

function detectLang(subPath: string): { code: string; title: string; priority: number } {
  const base = path.basename(subPath);
  const withoutSubExt = base.slice(0, -path.extname(base).length);
  const lastDot = withoutSubExt.lastIndexOf(".");
  if (lastDot >= 0) {
    const tag = withoutSubExt.slice(lastDot + 1).toLowerCase();
    if (LANG_MAP[tag]) return LANG_MAP[tag];
  }
  return { code: "und", title: path.basename(subPath), priority: 9 };
}

async function runMux(video: string, subs: string[], outputDir: string): Promise<string> {
  const videoBase = path.basename(video);
  const outputName = stemOf(video) + ".mkv";
  const outputPath = path.join(outputDir, outputName);

  fs.mkdirSync(outputDir, { recursive: true });

  const args: string[] = ["-y", "-i", video];
  for (const sub of subs) {
    args.push("-i", sub);
  }

  // Map all streams from video + each subtitle
  args.push("-map", "0");
  for (let i = 0; i < subs.length; i++) {
    args.push("-map", String(i + 1));
  }

  args.push("-c", "copy");

  // Metadata for each subtitle stream
  for (let i = 0; i < subs.length; i++) {
    const lang = detectLang(subs[i]);
    args.push(`-metadata:s:s:${i}`, `language=${lang.code}`);
    args.push(`-metadata:s:s:${i}`, `title=${lang.title}`);
  }

  args.push(outputPath);

  logger.info({ video: videoBase, subs: subs.map((s) => path.basename(s)), output: outputName }, "Muxing subtitles");

  await execFileAsync("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });

  logger.info({ output: outputName, size: (fs.statSync(outputPath).size / 1024 / 1024).toFixed(0) + " MB" }, "Mux complete");
  return outputPath;
}
