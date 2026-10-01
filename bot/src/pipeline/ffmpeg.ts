import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { config, logger } from "../config.js";

export async function splitVideo(inputPath: string, targetSizeMb: number, outputDir = config.paths.processing): Promise<string[]> {
  fs.mkdirSync(outputDir, { recursive: true });

  const basename = path.basename(inputPath, path.extname(inputPath));
  const ext = path.extname(inputPath);
  const targetBytes = Math.floor(targetSizeMb * 1024 * 1024);
  if (targetBytes <= 0) throw new Error("SPLIT_TARGET_SIZE_MB must be positive");

  const duration = await getVideoDuration(inputPath);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Cannot determine video duration for ${inputPath}`);
  }

  const fileSize = fs.statSync(inputPath).size;
  const numParts = Math.ceil(fileSize / targetBytes);
  let segmentDuration = Math.max(0.1, duration / numParts * 0.9);

  const outputPattern = path.join(outputDir, `${basename}.part%03d${ext}`);
  const partPrefix = `${basename}.part`;
  const getParts = () => fs.readdirSync(outputDir)
    .filter((name) => name.startsWith(partPrefix) && name.endsWith(ext)
      && /^\d+$/.test(name.slice(partPrefix.length, -ext.length)))
    .sort()
    .map((name) => path.join(outputDir, name));
  const removeParts = (parts: string[]) => {
    for (const part of parts) fs.rmSync(part, { force: true });
  };

  removeParts(getParts());
  for (let attempt = 0; attempt < 4; attempt++) {
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
    } catch (err) {
      removeParts(getParts());
      throw err;
    }

    const parts = getParts();
    if (parts.length === 0) throw new Error(`FFmpeg produced no video segments for ${inputPath}`);
    const sizes = parts.map((part) => fs.statSync(part).size);
    const largest = Math.max(...sizes);
    if (sizes.every((size) => size > 0 && size <= targetBytes)) {
      logger.info({ inputPath, parts: parts.length, segmentDuration }, "Video split into segments");
      return parts;
    }

    removeParts(parts);
    if (attempt === 3) {
      throw new Error(`FFmpeg could not split ${inputPath} into segments below ${targetBytes} bytes`);
    }
    segmentDuration = Math.max(0.1, Math.min(segmentDuration * 0.75, segmentDuration * targetBytes / largest * 0.8));
    logger.warn({ inputPath, segmentDuration, largest }, "Retrying oversized video segments");
  }

  throw new Error(`FFmpeg could not split ${inputPath}`);
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
    proc.stderr.on("data", (data) => { stderr = (stderr + data).slice(-2000); });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
    proc.on("error", reject);
  });
}
