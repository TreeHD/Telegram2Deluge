import { QBConfig, TorrentInfo, TorrentOptions } from "./types.js";
import { logger } from "../config.js";

export class QBClient {
  private config: QBConfig;
  private baseUrl: string;
  private cookie: string | null = null;

  constructor(config: QBConfig) {
    this.config = config;
    this.baseUrl = `http://${config.host}:${config.port}/api/v2`;
  }

  async connect(): Promise<void> {
    await this.login();
    logger.info("Connected to qBittorrent");
  }

  private async login(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `http://${this.config.host}:${this.config.port}`,
      },
      body: `username=${encodeURIComponent(this.config.username)}&password=${encodeURIComponent(this.config.password)}`,
    });

    const text = await res.text();
    const setCookie = res.headers.get("set-cookie");

    if (setCookie) {
      this.cookie = setCookie.split(";")[0];
    }

    // Some versions return 200 "Ok.", others return 200 "Fails.", others 403
    if (text === "Fails." || res.status === 403) {
      throw new Error(`qBittorrent login failed: ${text || `HTTP ${res.status}`}`);
    }

    if (!this.cookie) {
      throw new Error(`qBittorrent login failed: no session cookie received (HTTP ${res.status})`);
    }

    logger.info("qBittorrent login successful");
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    if (!this.cookie) await this.login();

    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> || {}),
      Cookie: this.cookie!,
      Referer: `http://${this.config.host}:${this.config.port}`,
    };

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (res.status === 403) {
      await this.login();
      headers.Cookie = this.cookie!;
      return fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers,
      });
    }

    return res;
  }

  async addTorrentFile(fileBuffer: Buffer, filename: string, options: TorrentOptions): Promise<string | null> {
    const form = new FormData();
    form.append("torrents", new Blob([new Uint8Array(fileBuffer)]), filename);
    if (options.savepath) form.append("savepath", options.savepath);

    const res = await this.request("/torrents/add", {
      method: "POST",
      body: form,
    });

    const text = await res.text();

    // Newer versions return JSON with added_torrent_ids
    try {
      const json = JSON.parse(text);
      if (json.added_torrent_ids?.length > 0) {
        return json.added_torrent_ids[0];
      }
      if (json.failure_count > 0) {
        throw new Error(`Failed to add torrent: ${text}`);
      }
    } catch (e) {
      // Older versions return "Ok." or "Fails."
      if (text === "Fails.") {
        throw new Error("Failed to add torrent");
      }
    }

    // Fallback: search for the torrent
    await new Promise((r) => setTimeout(r, 1000));
    const torrents = await this.getTorrents();
    const found = torrents.find((t) => t.name.includes(filename.replace(".torrent", "")));
    return found?.hash || null;
  }

  async addTorrentMagnet(uri: string, options: TorrentOptions): Promise<string | null> {
    const form = new FormData();
    form.append("urls", uri);
    if (options.savepath) form.append("savepath", options.savepath);

    const res = await this.request("/torrents/add", {
      method: "POST",
      body: form,
    });

    const text = await res.text();

    try {
      const json = JSON.parse(text);
      if (json.added_torrent_ids?.length > 0) {
        return json.added_torrent_ids[0];
      }
    } catch {
      if (text === "Fails.") {
        throw new Error("Failed to add magnet");
      }
    }

    // Fallback: extract hash from magnet URI
    const hashMatch = uri.match(/btih:([a-fA-F0-9]{40})/i) ||
      uri.match(/btih:([a-zA-Z2-7]{32})/i);
    if (hashMatch) {
      return hashMatch[1].toLowerCase();
    }

    await new Promise((r) => setTimeout(r, 1000));
    const torrents = await this.getTorrents();
    return torrents[torrents.length - 1]?.hash || null;
  }

  async addTorrentUrl(url: string, options: TorrentOptions): Promise<string | null> {
    const form = new FormData();
    form.append("urls", url);
    if (options.savepath) form.append("savepath", options.savepath);

    const res = await this.request("/torrents/add", {
      method: "POST",
      body: form,
    });

    const text = await res.text();

    try {
      const json = JSON.parse(text);
      if (json.added_torrent_ids?.length > 0) {
        return json.added_torrent_ids[0];
      }
    } catch {
      if (text === "Fails.") {
        throw new Error("Failed to add URL torrent");
      }
    }

    await new Promise((r) => setTimeout(r, 2000));
    const torrents = await this.getTorrents();
    return torrents[torrents.length - 1]?.hash || null;
  }

  async getTorrents(filter?: string): Promise<TorrentInfo[]> {
    const params = filter ? `?filter=${filter}` : "";
    const res = await this.request(`/torrents/info${params}`);
    return res.json() as Promise<TorrentInfo[]>;
  }

  async getTorrentInfo(hash: string): Promise<TorrentInfo | null> {
    const res = await this.request(`/torrents/info?hashes=${hash}`);
    const list = await res.json() as TorrentInfo[];
    return list[0] || null;
  }

  async getTorrentFiles(hash: string): Promise<Array<{ name: string; size: number }>> {
    const res = await this.request(`/torrents/files?hash=${hash}`);
    return res.json() as Promise<Array<{ name: string; size: number }>>;
  }

  async deleteTorrent(hash: string, deleteFiles: boolean = false): Promise<void> {
    await this.request(`/torrents/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `hashes=${hash}&deleteFiles=${deleteFiles}`,
    });
  }

  async pauseTorrent(hash: string): Promise<void> {
    // qBittorrent 5.0+ renamed /torrents/pause -> /torrents/stop.
    // Try the new endpoint first, fall back to the old one on 404.
    await this.postWithFallback(["/torrents/stop", "/torrents/pause"], `hashes=${hash}`);
  }

  async resumeTorrent(hash: string): Promise<void> {
    await this.postWithFallback(["/torrents/start", "/torrents/resume"], `hashes=${hash}`);
  }

  private async postWithFallback(paths: string[], body: string): Promise<void> {
    for (let i = 0; i < paths.length; i++) {
      const res = await this.request(paths[i], {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      // 404/405 means this version doesn't have the endpoint; try the next one.
      if (res.status === 404 || res.status === 405) {
        if (i < paths.length - 1) continue;
      }
      return;
    }
  }

  async getTransferInfo(): Promise<{ dl_info_speed: number; up_info_speed: number; free_space_on_disk: number }> {
    const res = await this.request("/transfer/info");
    return res.json() as any;
  }

  async addTrackers(hash: string, trackers: string[]): Promise<void> {
    await this.request("/torrents/addTrackers", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `hash=${hash}&urls=${encodeURIComponent(trackers.join("\n"))}`,
    });
  }

  disconnect() {
    this.cookie = null;
  }
}
