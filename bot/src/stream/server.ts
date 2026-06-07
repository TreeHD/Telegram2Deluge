import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, logger } from "../config.js";
import { verifyFileHash } from "./hash.js";
import { getStreamFile } from "../db/index.js";
import { generateStreamM3u8Content } from "./m3u8.js";

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".ts": "video/mp2t",
  ".zip": "application/zip",
  ".rar": "application/x-rar-compressed",
  ".7z": "application/x-7z-compressed",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".srt": "text/plain",
  ".ass": "text/plain",
  ".nfo": "text/plain",
};

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

async function resolveFileLocalPath(fileId: string): Promise<string | null> {
  const url = `${config.telegramApiRoot}/bot${config.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data.ok || !data.result?.file_path) return null;
    // Local Bot API: file_path is relative, full path is under telegram-bot-api data dir
    const filePath = path.join(config.paths.telegramData, data.result.file_path);
    if (fs.existsSync(filePath)) return filePath;
    return null;
  } catch {
    return null;
  }
}

export function createStreamServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const parts = url.pathname.split("/").filter(Boolean);

    // /stream/{jobId}/{filename}?hash=xxx
    if (parts.length < 3 || parts[0] !== "stream") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const jobId = parts[1];
    const filename = decodeURIComponent(parts.slice(2).join("/"));
    const hash = url.searchParams.get("hash") || "";

    if (!verifyFileHash(jobId, filename, hash)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Virtual m3u8 playlist
    if (filename === "playlist.m3u8") {
      const content = generateStreamM3u8Content(jobId);
      if (!content) {
        res.writeHead(404);
        res.end("No playlist available");
        return;
      }
      const buf = Buffer.from(content, "utf-8");
      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Content-Length": buf.length,
        "Content-Disposition": `inline; filename="playlist.m3u8"`,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(buf);
      return;
    }

    // Look up file_id from DB
    const streamFile = getStreamFile(jobId, filename);
    if (!streamFile) {
      res.writeHead(404);
      res.end("File Not Found");
      return;
    }

    // Resolve local path via Bot API getFile
    const filePath = await resolveFileLocalPath(streamFile.file_id);
    if (!filePath) {
      res.writeHead(404);
      res.end("File Not Available");
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const mimeType = getMimeType(filename);

    const rangeHeader = req.headers.range;

    if (!rangeHeader) {
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": fileSize,
        "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
        "Accept-Ranges": "bytes",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on("error", () => res.end());
      return;
    }

    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      res.end();
      return;
    }

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      res.end();
      return;
    }

    const contentLength = end - start + 1;

    res.writeHead(206, {
      "Content-Type": mimeType,
      "Content-Length": contentLength,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
      "Accept-Ranges": "bytes",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    stream.on("error", () => res.end());
  });

  server.listen(port, () => {
    logger.info({ port }, "Stream server started");
  });

  return server;
}
