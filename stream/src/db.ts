import Database from "better-sqlite3";

const DB_PATH = process.env.DB_PATH || "/data/queue/state.db";

let db: ReturnType<typeof Database>;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
  }
  return db;
}

export interface StreamFileRecord {
  filename: string;
  file_id: string;
  file_size: number;
}

export function getStreamFile(jobId: string, filename: string): StreamFileRecord | undefined {
  return getDb()
    .prepare("SELECT filename, file_id, file_size FROM stream_files WHERE job_id = ? AND filename = ?")
    .get(jobId, filename) as StreamFileRecord | undefined;
}

export function getStreamFiles(jobId: string): StreamFileRecord[] {
  return getDb()
    .prepare("SELECT filename, file_id, file_size FROM stream_files WHERE job_id = ?")
    .all(jobId) as StreamFileRecord[];
}
