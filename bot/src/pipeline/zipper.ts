import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, logger } from "../config.js";

/** Create one 7z archive split into real volumes that extraction tools can join. */
export async function splitTo7z(inputPath: string, targetSizeMb: number, outputDir = config.paths.processing): Promise<string[]> {
  const volumeBytes = Math.floor(targetSizeMb * 1024 * 1024);
  if (volumeBytes <= 0) throw new Error("SPLIT_TARGET_SIZE_MB must be positive");

  fs.mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, `${path.basename(inputPath)}.7z`);
  const archiveName = path.basename(archivePath);

  await run7z([
    "a", "-t7z", "-m0=lzma2", "-mx=7", `-v${volumeBytes}b`,
    "-bd", "-y", archivePath, `./${path.basename(inputPath)}`,
  ], path.dirname(inputPath));

  const parts = fs.readdirSync(outputDir)
    .filter((name) => name.startsWith(`${archiveName}.`) && /^\d+$/.test(name.slice(archiveName.length + 1)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(outputDir, name));

  if (parts.length === 0 || parts.some((part) => fs.statSync(part).size > volumeBytes)) {
    throw new Error(`7z did not create valid volumes for ${inputPath}`);
  }

  // Check the complete archive before any volume is uploaded or linked.
  await run7z(["t", "-bd", parts[0]], outputDir);
  logger.info({ inputPath, parts: parts.length }, "File split into 7z volumes");
  return parts;
}

function run7z(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("7z", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (data: Buffer) => { output = (output + data.toString()).slice(-2000); };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`7z exited with code ${code}: ${output}`));
    });
  });
}
