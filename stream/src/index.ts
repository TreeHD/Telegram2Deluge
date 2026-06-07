import http from "node:http";
import path from "node:path";
import { verifyFileHash, generateFileHash } from "./hash.js";
import { getStreamFile, getStreamFiles } from "./db.js";
import { resolveFile, getFileUrl } from "./telegram.js";

const PORT = parseInt(process.env.STREAM_PORT || "8082", 10);
const STREAM_HOST = process.env.STREAM_HOST || "";

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

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".m4v", ".ts", ".avi", ".mov", ".webm"]);

function isVideo(filename: string): boolean {
  return VIDEO_EXTS.has(path.extname(filename).toLowerCase());
}

function generateM3u8(jobId: string): string | null {
  const files = getStreamFiles(jobId);
  const videos = files.filter((f) => isVideo(f.filename));
  if (videos.length <= 1) return null;

  const lines = ["#EXTM3U"];
  for (const v of videos) {
    const hash = generateFileHash(jobId, v.filename);
    const url = `${STREAM_HOST}/stream/${jobId}/${encodeURIComponent(v.filename)}?hash=${hash}`;
    lines.push(`#EXTINF:-1,${v.filename}`);
    lines.push(url);
  }
  return lines.join("\n") + "\n";
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

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
    const content = generateM3u8(jobId);
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

  // Resolve file path via Bot API
  const tgFile = await resolveFile(streamFile.file_id);
  if (!tgFile) {
    res.writeHead(404);
    res.end("File Not Available");
    return;
  }

  const fileSize = tgFile.fileSize || streamFile.file_size;
  const mimeType = getMimeType(filename);
  const fileUrl = getFileUrl(tgFile.filePath);

  // Proxy the request to telegram-bot-api /file/ endpoint
  const proxyHeaders: Record<string, string> = {};
  if (req.headers.range) {
    proxyHeaders["Range"] = req.headers.range;
  }

  try {
    const upstream = await fetch(fileUrl, { headers: proxyHeaders });

    if (!upstream.ok && upstream.status !== 206) {
      res.writeHead(502);
      res.end("Upstream Error");
      return;
    }

    const headers: Record<string, string | number> = {
      "Content-Type": mimeType,
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
    };

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers["Content-Length"] = contentLength;

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers["Content-Range"] = contentRange;

    if (!contentLength && !contentRange && fileSize) {
      headers["Content-Length"] = fileSize;
    }

    const status = upstream.status === 206 ? 206 : 200;
    res.writeHead(status, headers);

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
        res.end();
      };
      pump().catch(() => res.end());
    } else {
      res.end();
    }
  } catch (err) {
    console.error("Proxy error:", err);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Proxy Error");
    }
  }
});

server.listen(PORT, () => {
  console.log(`Stream server listening on port ${PORT}`);
});
