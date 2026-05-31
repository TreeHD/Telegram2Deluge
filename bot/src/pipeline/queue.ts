import fs from "node:fs";
import path from "node:path";

export interface PipelineJob {
  id: string;
  torrentId: string;
  chatId: number;
  name: string;
  savePath: string;
  files: Array<{ path: string; size: number }>;
  totalSize: number;
  status: "pending" | "processing" | "done" | "failed";
}

export class JobQueue {
  private jobs: PipelineJob[] = [];
  private filePath: string;

  constructor(queueDir: string) {
    this.filePath = path.join(queueDir, "jobs.json");
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf-8");
        this.jobs = JSON.parse(data);
      }
    } catch {
      this.jobs = [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.jobs, null, 2));
  }

  add(job: PipelineJob) {
    this.jobs.push(job);
    this.save();
  }

  next(): PipelineJob | undefined {
    return this.jobs.find((j) => j.status === "pending");
  }

  getAll(): PipelineJob[] {
    return this.jobs;
  }

  getActive(): PipelineJob[] {
    return this.jobs.filter((j) => j.status === "pending" || j.status === "processing");
  }
}
