import { getStreamFiles } from "../db/index.js";
import { generateM3u8 } from "../utils/m3u8.js";
import { getStreamUrlForFile } from "./urls.js";

export { createStreamServer } from "./server.js";
export { getStreamUrlForFile } from "./urls.js";

export function getStreamLinksForJob(jobId: string): string[] {
  const files = getStreamFiles(jobId);
  if (files.length === 0) return [];

  return files.map((f) => getStreamUrlForFile(jobId, f.filename));
}

export function generateStreamM3u8(jobId: string): string | null {
  const files = getStreamFiles(jobId);
  const entries = files.map((f) => ({
    filename: f.filename,
    url: getStreamUrlForFile(jobId, f.filename),
  }));

  return generateM3u8(entries);
}
