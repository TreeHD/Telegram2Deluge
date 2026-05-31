import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config, logger } from "../config.js";
import fs from "node:fs";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

export async function uploadToR2(filePath: string, key: string): Promise<void> {
  const fileStream = fs.createReadStream(filePath);
  const fileSize = fs.statSync(filePath).size;

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: config.r2.bucketName,
      Key: key,
      Body: fileStream,
      ContentLength: fileSize,
    },
    queueSize: 4,
    partSize: 64 * 1024 * 1024,
  });

  await upload.done();
  logger.info({ key, size: fileSize }, "Uploaded to R2");
}

export async function getPresignedUrl(key: string): Promise<string> {
  if (config.r2.publicUrl) {
    return `${config.r2.publicUrl}/${key}`;
  }

  const command = new GetObjectCommand({
    Bucket: config.r2.bucketName,
    Key: key,
  });

  return getSignedUrl(s3, command, { expiresIn: 86400 });
}
