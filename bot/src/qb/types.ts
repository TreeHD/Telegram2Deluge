export interface QBConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface TorrentOptions {
  savepath?: string;
}

export interface TorrentInfo {
  hash: string;
  name: string;
  progress: number;
  state: string;
  dlspeed: number;
  upspeed: number;
  uploaded: number;
  eta: number;
  size: number;
  save_path: string;
}

export interface TorrentFile {
  name: string;
  size: number;
  index: number;
}
