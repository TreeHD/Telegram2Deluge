import { config } from "../config.js";
import { generateFileHash } from "./hash.js";

export function getStreamUrlForFile(jobId: string, filename: string): string {
  const hash = generateFileHash(jobId, filename);
  return `${config.streamHost}/stream/${jobId}/${encodeURIComponent(filename)}?hash=${hash}`;
}
