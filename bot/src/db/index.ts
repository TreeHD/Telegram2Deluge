import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { config, logger } from "../config.js";

const DB_PATH = path.join(config.paths.queue, "state.db");
fs.mkdirSync(config.paths.queue, { recursive: true });

const db: DatabaseType = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_torrents (
    hash TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    last_progress INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id TEXT PRIMARY KEY,
    torrent_id TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    save_path TEXT NOT NULL,
    files TEXT NOT NULL,
    total_size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS pending_actions (
    job_id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    files TEXT NOT NULL,
    download_path TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
`);

// Migration: add message_id column if missing
try {
  db.prepare("SELECT message_id FROM pipeline_jobs LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE pipeline_jobs ADD COLUMN message_id INTEGER NOT NULL DEFAULT 0");
}

// Tracked torrents
export function addTrackedTorrent(hash: string, chatId: number, messageId: number) {
  db.prepare(
    "INSERT OR REPLACE INTO tracked_torrents (hash, chat_id, message_id, last_progress) VALUES (?, ?, ?, 0)"
  ).run(hash, chatId, messageId);
}

export function updateTrackedProgress(hash: string, progress: number) {
  db.prepare("UPDATE tracked_torrents SET last_progress = ? WHERE hash = ?").run(progress, hash);
}

export function removeTrackedTorrent(hash: string) {
  db.prepare("DELETE FROM tracked_torrents WHERE hash = ?").run(hash);
}

export function getAllTrackedTorrents(): Array<{ hash: string; chat_id: number; message_id: number; last_progress: number }> {
  return db.prepare("SELECT hash, chat_id, message_id, last_progress FROM tracked_torrents").all() as any;
}

// Pipeline jobs
export function addPipelineJob(job: { id: string; torrentId: string; chatId: number; messageId: number; name: string; savePath: string; files: Array<{ path: string; size: number }>; totalSize: number; status: string }) {
  db.prepare(
    "INSERT OR REPLACE INTO pipeline_jobs (id, torrent_id, chat_id, message_id, name, save_path, files, total_size, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(job.id, job.torrentId, job.chatId, job.messageId, job.name, job.savePath, JSON.stringify(job.files), job.totalSize, job.status);
}

export function updateJobStatus(id: string, status: string) {
  db.prepare("UPDATE pipeline_jobs SET status = ? WHERE id = ?").run(status, id);
}

export function getNextPendingJob(): { id: string; torrent_id: string; chat_id: number; message_id: number; name: string; save_path: string; files: string; total_size: number; status: string } | undefined {
  return db.prepare("SELECT * FROM pipeline_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1").get() as any;
}

export function getAllActiveJobs(): Array<{ id: string; torrent_id: string; chat_id: number; message_id: number; name: string; save_path: string; files: string; total_size: number; status: string }> {
  return db.prepare("SELECT * FROM pipeline_jobs WHERE status IN ('pending', 'processing') ORDER BY created_at ASC").all() as any;
}

// Pending R2 actions
export function addPendingAction(jobId: string, chatId: number, files: string[], downloadPath: string) {
  db.prepare(
    "INSERT OR REPLACE INTO pending_actions (job_id, chat_id, files, download_path) VALUES (?, ?, ?, ?)"
  ).run(jobId, chatId, JSON.stringify(files), downloadPath);
}

export function getPendingAction(jobId: string): { job_id: string; chat_id: number; files: string; download_path: string } | undefined {
  return db.prepare("SELECT * FROM pending_actions WHERE job_id = ?").get(jobId) as any;
}

export function getAllPendingActions(): Array<{ job_id: string; chat_id: number; files: string; download_path: string }> {
  return db.prepare("SELECT * FROM pending_actions").all() as any;
}

export function removePendingAction(jobId: string) {
  db.prepare("DELETE FROM pending_actions WHERE job_id = ?").run(jobId);
}

export function getJobById(jobId: string): { id: string; torrent_id: string; chat_id: number; message_id: number; name: string } | undefined {
  return db.prepare("SELECT id, torrent_id, chat_id, message_id, name FROM pipeline_jobs WHERE id = ?").get(jobId) as any;
}

export { db };
