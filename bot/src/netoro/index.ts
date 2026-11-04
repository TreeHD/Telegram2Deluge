import { config } from "../config.js";

export function isNetoroEnabled(): boolean {
  return Boolean(config.netoro.url && config.netoro.token);
}

export interface NetoroResult {
  id: string;
  title: string;
  type: string;
  entry_count: number;
}

export async function uploadM3u8ToNetoro(m3u8: string, title: string): Promise<NetoroResult> {
  const form = new FormData();
  form.append("file", new Blob([m3u8], { type: "application/vnd.apple.mpegurl" }), "playlist.m3u8");
  form.append("title", title.slice(0, 200));

  const endpoint = `${config.netoro.url.replace(/\/+$/, "")}/api/media`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.netoro.token}` },
    body: form,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Netoro ${res.status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body) as NetoroResult;
}
