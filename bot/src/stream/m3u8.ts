import { getStreamFiles } from "../db/index.js";
import { getStreamUrlForFile } from "./urls.js";
import { generateM3u8 } from "../utils/m3u8.js";

export function generateStreamM3u8Content(jobId: string): string | null {
  const files = getStreamFiles(jobId);
  const entries = files.map((f) => ({
    filename: f.filename,
    url: getStreamUrlForFile(jobId, f.filename),
  }));

  return generateM3u8(entries);
}
