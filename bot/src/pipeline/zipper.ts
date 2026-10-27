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
    "a", "-t7z", "-m0=lzma2", "-mx=9", `-v${volumeBytes}b`,
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

/** Package a job without flattening its download directory or silently omitting files. */
export async function create7zArchive(
  files: string[], name: string, sourceRoot: string, outputDir: string, targetSizeMb?: number,
): Promise<string[]> {
  if (files.length === 0) throw new Error("沒有可打包的檔案。");
  const volumeBytes = targetSizeMb === undefined ? undefined : Math.floor(targetSizeMb * 1024 * 1024);
  if (volumeBytes !== undefined && (!Number.isSafeInteger(volumeBytes) || volumeBytes <= 0)) {
    throw new Error("SPLIT_TARGET_SIZE_MB must be positive");
  }
  const staging = path.join(outputDir, "contents");
  fs.mkdirSync(staging, { recursive: true });
  // Keep the filename short enough for Telegram and common filesystems.
  const safeName = Array.from(path.basename(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")).slice(0, 60).join("") || "archive";
  const archive = path.resolve(outputDir, `${safeName}.7z`);
  const entries = new Set<string>();
  try {
    for (const file of files) {
      if (!fs.statSync(file).isFile()) throw new Error(`不是一般檔案: ${file}`);
      const relative = path.relative(sourceRoot, file);
      const entry = relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
        ? relative : path.basename(file);
      if (entries.has(entry)) throw new Error(`7z 內檔名重複: ${entry}`);
      entries.add(entry);
      const destination = path.join(staging, entry);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      try {
        await fs.promises.link(file, destination);
      } catch (err: any) {
        if (err.code !== "EXDEV") throw err;
        await fs.promises.copyFile(file, destination);
      }
    }
    await run7z([
      "a", "-t7z", "-m0=lzma2", "-mx=9", "-bd", "-y",
      ...(volumeBytes === undefined ? [] : [`-v${volumeBytes}b`]), archive, ".",
    ], staging);
    let outputs = volumeBytes === undefined ? [archive] : fs.readdirSync(outputDir)
      .filter((entry) => entry.startsWith(`${path.basename(archive)}.`) && /^\d+$/.test(entry.slice(path.basename(archive).length + 1)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((entry) => path.join(outputDir, entry));
    if (outputs.length === 0 || outputs.some((file) => volumeBytes !== undefined && fs.statSync(file).size > volumeBytes)) {
      throw new Error("7z 分卷建立失敗。");
    }
    await run7z(["t", "-bd", path.resolve(outputs[0])], outputDir);
    // A single volume is an ordinary 7z; give it the conventional extension.
    if (volumeBytes !== undefined && outputs.length === 1) {
      fs.renameSync(outputs[0], archive);
      outputs = [archive];
    }
    return outputs;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
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
