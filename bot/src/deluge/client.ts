import { DelugeConfig, TorrentOptions, TorrentStatus } from "./types.js";
import { logger } from "../config.js";

export class DelugeClient {
  private config: DelugeConfig;
  private baseUrl: string;
  private cookie: string | null = null;
  private requestId = 0;

  constructor(config: DelugeConfig) {
    this.config = config;
    this.baseUrl = `http://${config.host}:${config.webPort}/json`;
  }

  async connect(): Promise<void> {
    await this.login();
    const connected = await this.rpc("web.connected");
    if (!connected) {
      const hosts = await this.rpc("web.get_hosts");
      if (hosts && hosts.length > 0) {
        await this.rpc("web.connect", [hosts[0][0]]);
      }
    }
    logger.info("Connected to Deluge Web UI");
  }

  private async login(): Promise<void> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "auth.login",
        params: [this.config.password],
        id: this.requestId++,
      }),
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      this.cookie = setCookie.split(";")[0];
    }

    const data = await res.json() as any;
    if (!data.result) {
      throw new Error("Deluge auth.login failed");
    }
  }

  private async rpc(method: string, params: any[] = []): Promise<any> {
    if (!this.cookie) {
      await this.login();
    }

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie!,
      },
      body: JSON.stringify({
        method,
        params,
        id: this.requestId++,
      }),
    });

    const data = await res.json() as any;

    if (data.error) {
      if (data.error.code === 1) {
        // Session expired, re-login
        await this.login();
        return this.rpc(method, params);
      }
      throw new Error(`Deluge RPC error: ${data.error.message}`);
    }

    return data.result;
  }

  async addTorrentFile(filename: string, filedump: string, options: TorrentOptions): Promise<string> {
    return this.rpc("core.add_torrent_file", [filename, filedump, options]);
  }

  async addTorrentMagnet(uri: string, options: TorrentOptions): Promise<string> {
    return this.rpc("core.add_torrent_magnet", [uri, options]);
  }

  async addTorrentUrl(url: string, options: TorrentOptions): Promise<string> {
    return this.rpc("core.add_torrent_url", [url, options]);
  }

  async getTorrentStatus(torrentId: string, keys: string[]): Promise<TorrentStatus> {
    return this.rpc("core.get_torrent_status", [torrentId, keys]);
  }

  async getTorrentsStatus(
    filter: Record<string, any>,
    keys: string[]
  ): Promise<Record<string, any>> {
    return this.rpc("core.get_torrents_status", [filter, keys]);
  }

  async removeTorrent(torrentId: string, removeData: boolean = false): Promise<boolean> {
    return this.rpc("core.remove_torrent", [torrentId, removeData]);
  }

  async getSessionStatus(keys: string[]): Promise<Record<string, any>> {
    return this.rpc("core.get_session_status", [keys]);
  }

  disconnect() {
    this.cookie = null;
  }
}
