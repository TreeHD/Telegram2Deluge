import archiver from "archiver";
import fs from "node:fs";
import path from "node:path";
import { config, logger } from "../config.js";

export async function splitToZip(inputPath: string, targetSizeMb: number): Promise<string[]> {
  const outputDir = config.paths.processing;
  fs.mkdirSync(outputDir, { recursive: true });

  const basename = path.basename(inputPath, path.extname(inputPath));
  const fileSize = fs.statSync(inputPath).size;
  const splitSize = (targetSizeMb - 50) * 1024 * 1024;
  const partCount = Math.ceil(fileSize / splitSize);

  if (partCount <= 1) {
    const outputPath = path.join(outputDir, `${basename}.zip`);
    await createZipWithFile(inputPath, outputPath);
    return [outputPath];
  }

  const parts: string[] = [];

  for (let i = 0; i < partCount; i++) {
    const partNum = String(i + 1).padStart(2, "0");
    const outputPath = path.join(outputDir, `${basename}.part${partNum}.zip`);
    const start = i * splitSize;
    const end = Math.min(start + splitSize, fileSize);

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver("zip", { zlib: { level: 1 } });

      output.on("close", () => resolve());
      archive.on("error", (err) => reject(err));

      archive.pipe(output);

      // Stream a slice of the file without loading entire file into memory
      const readStream = fs.createReadStream(inputPath, { start, end: end - 1 });
      archive.append(readStream, {
        name: `${path.basename(inputPath)}.part${partNum}`,
      });
      archive.finalize();
    });

    parts.push(outputPath);
  }

  logger.info({ inputPath, parts: parts.length }, "File split into zip parts");
  return parts;
}

async function createZipWithFile(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 1 } });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.file(inputPath, { name: path.basename(inputPath) });
    archive.finalize();
  });
}
