import tls from "node:tls";
import zlib from "node:zlib";
import { rencodeEncode, rencodeDecode } from "./protocol.js";
import { DelugeConfig, TorrentOptions, TorrentStatus } from "./types.js";
import { logger } from "../config.js";

const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 5;

export class DelugeClient {
  private config: DelugeConfig;
  private socket: tls.TLSSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = Buffer.alloc(0);
  private useHeader = true;

  constructor(config: DelugeConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // Try with header first (Deluge 2.x), fall back to without (Deluge 1.x)
    try {
      this.useHeader = true;
      await this.tryConnect();
    } catch (err) {
      logger.info("Header-based protocol failed, trying without header...");
      this.socket?.destroy();
      this.socket = null;
      this.buffer = Buffer.alloc(0);
      this.requestId = 0;
      this.pending.clear();
      this.useHeader = false;
      await this.tryConnect();
    }
  }

  private async tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 15000);

      this.socket = tls.connect(
        {
          host: this.config.host,
          port: this.config.port,
          rejectUnauthorized: false,
        },
        async () => {
          try {
            logger.info({ useHeader: this.useHeader }, "TLS connected, attempting login...");
            await this.call("daemon.login", [this.config.username, this.config.password]);
            clearTimeout(timeout);
            logger.info("Deluge daemon login successful");
            resolve();
          } catch (err) {
            clearTimeout(timeout);
            reject(err);
          }
        }
      );

      this.socket.on("data", (data) => this.onData(data));
      this.socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      this.socket.on("close", () => {
        logger.warn("Deluge connection closed");
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
    logger.debug({ bytes: chunk.length, hex: chunk.subarray(0, 20).toString("hex") }, "Received data from Deluge");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer() {
    if (this.useHeader) {
      this.processBufferWithHeader();
    } else {
      this.processBufferRaw();
    }
  }

  private processBufferWithHeader() {
    while (this.buffer.length >= HEADER_SIZE) {
      const version = this.buffer[0];
      const payloadLength = this.buffer.readUInt32BE(1);

      if (this.buffer.length < HEADER_SIZE + payloadLength) {
        break;
      }

      const payload = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength);
      this.buffer = this.buffer.subarray(HEADER_SIZE + payloadLength);

      try {
        const decompressed = zlib.inflateSync(payload);
        const message = rencodeDecode(decompressed);
        this.handleMessage(message);
      } catch (err) {
        logger.error(err, "Failed to decode Deluge response (header mode)");
      }
    }
  }

  private processBufferRaw() {
    // Without header: try to decompress the entire buffer as one zlib stream
    if (this.buffer.length === 0) return;

    try {
      const decompressed = zlib.inflateSync(this.buffer);
      this.buffer = Buffer.alloc(0);
      const message = rencodeDecode(decompressed);
      this.handleMessage(message);
    } catch {
      // Incomplete data, wait for more
    }
  }

  private handleMessage(message: any) {
    if (!Array.isArray(message)) {
      logger.debug({ message }, "Non-array message received");
      return;
    }

    // Response format: [[msgType, requestId, data], ...]
    // or single: [msgType, requestId, data]
    const messages = Array.isArray(message[0]) ? message : [message];

    for (const msg of messages) {
      const [msgType, requestId, data] = msg;

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
  }

  private async call(method: string, args: any[] = [], kwargs: Record<string, any> = {}): Promise<any> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Not connected to Deluge daemon");
    }

    const id = this.requestId++;
    const request = [[id, method, args, kwargs]];
    const encoded = rencodeEncode(request);
    const compressed = zlib.deflateSync(encoded);

    let frame: Buffer;
    if (this.useHeader) {
      const header = Buffer.alloc(HEADER_SIZE);
      header[0] = PROTOCOL_VERSION;
      header.writeUInt32BE(compressed.length, 1);
      frame = Buffer.concat([header, compressed]);
    } else {
      frame = compressed;
    }

    logger.debug({ method, id, frameSize: frame.length, useHeader: this.useHeader }, "Sending RPC call");

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(frame);

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 15000);
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
