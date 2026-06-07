import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { config, logger } from "../config.js";

export async function splitVideo(inputPath: string, targetSizeMb: number): Promise<string[]> {
  const outputDir = config.paths.processing;
  fs.mkdirSync(outputDir, { recursive: true });

  const basename = path.basename(inputPath, path.extname(inputPath));
  const ext = path.extname(inputPath);

  const duration = await getVideoDuration(inputPath);
  if (!duration || duration <= 0) {
    logger.warn({ inputPath }, "Cannot determine video duration, returning as-is");
    return [inputPath];
  }

  const fileSize = fs.statSync(inputPath).size;
  const targetBytes = targetSizeMb * 1024 * 1024;
  const numParts = Math.ceil(fileSize / targetBytes);
  const segmentDuration = Math.floor(duration / numParts);

  if (segmentDuration < 10) {
    logger.warn({ inputPath, segmentDuration }, "Segment duration too short");
    return [inputPath];
  }

  const outputPattern = path.join(outputDir, `${basename}.part%03d${ext}`);

  try {
    await runFfmpeg([
      "-y", "-i", inputPath,
      "-c", "copy",
      "-map", "0",
      "-f", "segment",
      "-segment_time", `${segmentDuration}`,
      "-reset_timestamps", "1",
      outputPattern,
    ]);

    const parts: string[] = [];
    const files = fs.readdirSync(outputDir).sort();
    for (const f of files) {
      if (f.startsWith(`${basename}.part`) && f.endsWith(ext)) {
        parts.push(path.join(outputDir, f));
      }
    }

    if (parts.length === 0) {
      logger.error({ inputPath }, "FFmpeg segment produced no output");
      return [inputPath];
    }

    logger.info({ inputPath, parts: parts.length, segmentDuration }, "Video split into segments");
    return parts;
  } catch (err) {
    logger.error(err, "FFmpeg segment failed");
    return [inputPath];
  }
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      filePath,
    ]);

    let output = "";
    proc.stdout.on("data", (data) => { output += data; });
    proc.on("close", (code) => {
      if (code !== 0) return resolve(0);
      try {
        const info = JSON.parse(output);
        resolve(parseFloat(info.format?.duration || "0"));
      } catch {
        resolve(0);
      }
    });
    proc.on("error", () => resolve(0));
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (data) => { stderr += data; });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
    proc.on("error", reject);
  });
}
