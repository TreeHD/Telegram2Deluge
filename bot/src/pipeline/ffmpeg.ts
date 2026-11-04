import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { config, logger } from "../config.js";

export async function splitVideo(inputPath: string, targetSizeMb: number, outputDir = config.paths.processing): Promise<string[]> {
  fs.mkdirSync(outputDir, { recursive: true });

  const basename = path.basename(inputPath, path.extname(inputPath));
  const ext = path.extname(inputPath);
  const targetBytes = Math.floor(targetSizeMb * 1024 * 1024);
  if (targetBytes <= 0) throw new Error("SPLIT_TARGET_SIZE_MB must be positive");

  const { duration, startTime } = await getVideoInfo(inputPath);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Cannot determine video duration for ${inputPath}`);
  }

  const fileSize = fs.statSync(inputPath).size;
  const keyframes = await getKeyframes(inputPath);
  // Leave a little room: remuxed parts are not byte-identical to the source ranges.
  let limitBytes = targetBytes * 0.97;

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
    const cuts = planCuts(keyframes, fileSize, limitBytes, startTime, duration);
    try {
      await runFfmpeg([
        "-y", "-i", inputPath,
        "-c", "copy",
        "-map", "0",
        "-f", "segment",
        "-segment_times", cuts.map((t) => t.toFixed(3)).join(","),
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
      logger.info({ inputPath, parts: parts.length, sizes }, "Video split into segments");
      return parts;
    }

    removeParts(parts);
    if (attempt === 3) {
      throw new Error(`FFmpeg could not split ${inputPath} into segments below ${targetBytes} bytes`);
    }
    limitBytes = Math.min(limitBytes * 0.9, limitBytes * targetBytes / largest * 0.95);
    logger.warn({ inputPath, limitBytes, largest }, "Retrying oversized video segments");
  }

  throw new Error(`FFmpeg could not split ${inputPath}`);
}

interface Keyframe {
  time: number;
  pos: number;
}

/**
 * Pick cut times so each part covers at most `limitBytes` of the source file.
 * Cuts land on keyframes, which is where `-c copy` segmenting can split.
 */
function planCuts(keyframes: Keyframe[], fileSize: number, limitBytes: number, startTime: number, duration: number): number[] {
  const cuts: number[] = [];
  if (keyframes.length > 1) {
    let segmentStart = keyframes[0].pos;
    let previous = keyframes[0];
    // The end of the file acts as a final boundary so the last part is checked too.
    for (const keyframe of [...keyframes.slice(1), { time: Infinity, pos: fileSize }]) {
      if (keyframe.pos - segmentStart > limitBytes && previous.pos > segmentStart) {
        // Step back slightly so rounding cannot push the cut to the next keyframe.
        cuts.push(previous.time - startTime - 0.001);
        segmentStart = previous.pos;
      }
      previous = keyframe;
    }
  }
  if (cuts.length > 0) return cuts;

  // No usable keyframe positions: fall back to equal-length cuts.
  const numParts = Math.max(2, Math.ceil(fileSize / limitBytes));
  for (let i = 1; i < numParts; i++) cuts.push(duration * i / numParts);
  return cuts;
}

/** Byte offsets and timestamps of the main video stream's keyframes. */
async function getKeyframes(filePath: string): Promise<Keyframe[]> {
  const proc = spawn("ffprobe", [
    "-v", "error",
    "-select_streams", "V:0",
    "-show_entries", "packet=pts_time,pos,flags",
    "-of", "compact=p=0",
    filePath,
  ], { stdio: ["ignore", "pipe", "ignore"] });

  const keyframes: Keyframe[] = [];
  const lines = readline.createInterface({ input: proc.stdout });
  lines.on("line", (line) => {
    const fields: Record<string, string> = {};
    for (const entry of line.split("|")) {
      const eq = entry.indexOf("=");
      if (eq > 0) fields[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    if (!fields.flags?.includes("K")) return;
    const time = parseFloat(fields.pts_time);
    const pos = parseInt(fields.pos, 10);
    if (Number.isFinite(time) && Number.isFinite(pos)) keyframes.push({ time, pos });
  });

  const [code] = await Promise.all([
    new Promise<number | null>((resolve) => {
      proc.on("close", resolve);
      proc.on("error", () => resolve(null));
    }),
    new Promise<void>((resolve) => lines.on("close", resolve)),
  ]);
  if (code !== 0) {
    logger.warn({ filePath, code }, "ffprobe could not list keyframes; using equal-length cuts");
    return [];
  }
  return keyframes.sort((a, b) => a.time - b.time);
}

function getVideoInfo(filePath: string): Promise<{ duration: number; startTime: number }> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      filePath,
    ]);

    let output = "";
    const fail = { duration: 0, startTime: 0 };
    proc.stdout.on("data", (data) => { output += data; });
    proc.on("close", (code) => {
      if (code !== 0) return resolve(fail);
      try {
        const info = JSON.parse(output);
        const startTime = parseFloat(info.format?.start_time || "0");
        resolve({
          duration: parseFloat(info.format?.duration || "0"),
          startTime: Number.isFinite(startTime) ? startTime : 0,
        });
      } catch {
        resolve(fail);
      }
    });
    proc.on("error", () => resolve(fail));
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
