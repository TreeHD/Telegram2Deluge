export interface DelugeConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface TorrentOptions {
  download_location?: string;
  max_download_speed?: number;
  max_upload_speed?: number;
}

export interface TorrentStatus {
  name: string;
  progress: number;
  state: string;
  download_payload_rate: number;
  upload_payload_rate: number;
  eta: number;
  total_size: number;
  save_path: string;
  files: TorrentFile[];
}

export interface TorrentFile {
  path: string;
  size: number;
  index: number;
}

export type RpcMessage = [number, number, string, any[], Record<string, any>];
export type RpcResponse = [number, number, any];

export const RPC_RESPONSE = 1;
export const RPC_ERROR = 2;
export const RPC_EVENT = 3;
