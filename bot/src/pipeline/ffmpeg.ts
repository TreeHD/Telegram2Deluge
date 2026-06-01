import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { config, logger } from "../config.js";

export async function compressVideo(inputPath: string, targetSizeMb: number): Promise<string | null> {
  const outputDir = config.paths.processing;
  fs.mkdirSync(outputDir, { recursive: true });

  const basename = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(outputDir, `${basename}_compressed.mp4`);

  const duration = await getVideoDuration(inputPath);
  if (!duration || duration <= 0) {
    logger.warn({ inputPath }, "Cannot determine video duration");
    return null;
  }

  const targetBits = targetSizeMb * 1024 * 1024 * 8;
  const audioBitrate = 128000;
  const videoBitrate = Math.floor((targetBits / duration) - audioBitrate);

  if (videoBitrate < 500000) {
    logger.warn({ inputPath, videoBitrate }, "Target bitrate too low, skipping compression");
    return null;
  }

  const passLogFile = path.join(outputDir, `${basename}_passlog`);

  try {
    // Pass 1
    await runFfmpeg([
      "-y", "-i", inputPath,
      "-c:v", "libx264", "-b:v", `${videoBitrate}`,
      "-preset", config.ffmpeg.preset,
      "-pass", "1", "-passlogfile", passLogFile,
      "-an", "-f", "null", "/dev/null",
    ]);

    // Pass 2
    await runFfmpeg([
      "-y", "-i", inputPath,
      "-c:v", "libx264", "-b:v", `${videoBitrate}`,
      "-preset", config.ffmpeg.preset,
      "-pass", "2", "-passlogfile", passLogFile,
      "-c:a", "aac", "-b:a", "128k",
      outputPath,
    ]);

    const outputSize = fs.statSync(outputPath).size / 1024 / 1024;
    if (outputSize > targetSizeMb) {
      logger.warn({ outputSize, targetSizeMb }, "Compressed video still too large");
      fs.unlinkSync(outputPath);
      return null;
    }

    // Clean passlog files
    for (const f of fs.readdirSync(outputDir)) {
      if (f.startsWith(`${basename}_passlog`)) {
        fs.unlinkSync(path.join(outputDir, f));
      }
    }

    logger.info({ inputPath, outputPath, outputSize: `${outputSize.toFixed(0)}MB` }, "Video compressed");
    return outputPath;
  } catch (err) {
    logger.error(err, "FFmpeg compression failed");
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return null;
  }
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
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
