import crypto from "node:crypto";

const SECRET = process.env.STREAM_SECRET || crypto.randomBytes(32).toString("hex");

export function generateFileHash(jobId: string, filename: string): string {
  const hmac = crypto.createHmac("sha256", SECRET);
  hmac.update(`${jobId}:${filename}`);
  return hmac.digest("hex").slice(0, 16);
}

export function verifyFileHash(jobId: string, filename: string, hash: string): boolean {
  return hash === generateFileHash(jobId, filename);
}
