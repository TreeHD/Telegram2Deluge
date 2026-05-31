import tls from "node:tls";
import { EventEmitter } from "node:events";
import { rencodeEncode, rencodeDecode, compressFrame, decompressFrame } from "./protocol.js";
import { DelugeConfig, TorrentOptions, TorrentStatus } from "./types.js";
import { logger } from "../config.js";

const PROTOCOL_VERSION = 1;

export class DelugeClient extends EventEmitter {
  private config: DelugeConfig;
  private socket: tls.TLSSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = Buffer.alloc(0);

  constructor(config: DelugeConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect(
        {
          host: this.config.host,
          port: this.config.port,
          rejectUnauthorized: false,
        },
        async () => {
          try {
            await this.call("daemon.login", [this.config.username, this.config.password]);
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );

      this.socket.on("data", (data) => this.onData(data));
      this.socket.on("error", (err) => {
        logger.error(err, "Deluge socket error");
        this.emit("error", err);
        reject(err);
      });
      this.socket.on("close", () => {
        logger.warn("Deluge connection closed");
        this.emit("close");
      });
    });
  }

  async reconnect(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    await this.connect();
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer() {
    while (this.buffer.length > 0) {
      try {
        const decompressed = decompressFrame(this.buffer);
        const message = rencodeDecode(decompressed);
        this.buffer = Buffer.alloc(0);
        this.handleMessage(message);
      } catch {
        // incomplete data, wait for more
        break;
      }
    }
  }

  private handleMessage(message: any) {
    if (!Array.isArray(message)) return;

    const [msgType, requestId, data] = message;

    if (msgType === 1) {
      const pending = this.pending.get(requestId);
      if (pending) {
        pending.resolve(data);
        this.pending.delete(requestId);
      }
    } else if (msgType === 2) {
      const pending = this.pending.get(requestId);
      if (pending) {
        const errMsg = Array.isArray(data) ? data.join("\n") : String(data);
        pending.reject(new Error(`Deluge RPC error: ${errMsg}`));
        this.pending.delete(requestId);
      }
    }
  }

  private async call(method: string, args: any[] = [], kwargs: Record<string, any> = {}): Promise<any> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Not connected to Deluge daemon");
    }

    const id = this.requestId++;
    const request = [[id, method, args, kwargs]];
    const encoded = rencodeEncode(request);
    const compressed = compressFrame(encoded);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(compressed);

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async addTorrentFile(filename: string, filedump: string, options: TorrentOptions): Promise<string> {
    return this.call("core.add_torrent_file", [filename, filedump, options]);
  }

  async addTorrentMagnet(uri: string, options: TorrentOptions): Promise<string> {
    return this.call("core.add_torrent_magnet", [uri, options]);
  }

  async addTorrentUrl(url: string, options: TorrentOptions): Promise<string> {
    return this.call("core.add_torrent_url", [url, options]);
  }

  async getTorrentStatus(torrentId: string, keys: string[]): Promise<TorrentStatus> {
    return this.call("core.get_torrent_status", [torrentId, keys]);
  }

  async getTorrentsStatus(
    filter: Record<string, any>,
    keys: string[]
  ): Promise<Record<string, any>> {
    return this.call("core.get_torrents_status", [filter, keys]);
  }

  async removeTorrent(torrentId: string, removeData: boolean = false): Promise<boolean> {
    return this.call("core.remove_torrent", [torrentId, removeData]);
  }

  async getSessionStatus(keys: string[]): Promise<Record<string, any>> {
    return this.call("core.get_session_status", [keys]);
  }

  disconnect() {
    this.socket?.destroy();
    this.socket = null;
  }
}
