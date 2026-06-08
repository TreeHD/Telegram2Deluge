# TGTransmission

Telegram Bot 串接 qBittorrent，自動下載種子並上傳到 Telegram + Cloudflare R2 + Filebin + Stream 直鏈。

## 功能

- 傳送 `.torrent` 檔案、磁力鏈結或 URL 給 Bot，自動加入 qBittorrent 下載
- 下載進度即時更新（每 15 秒編輯訊息 + 進度條）
- 影片超過 2GB 自動 ffmpeg 切片（-c copy，不重新編碼）
- 非影片超過 2GB 自動 zip 分割
- 上傳到指定群組，原訊息顯示檔案超連結清單
- 可選上傳到 Cloudflare R2（24hr presigned URL）
- 可選上傳到 Filebin（免費空間）
- 可選 Stream 直鏈（MTProto 即時串流，零本地快取）
- 多影片自動產生 m3u8 播放列表
- 平行上傳（6 concurrent）
- `/status` 查看下載進度
- `/list` 互動式任務列表（點按查看詳情/操作）
- `/disk` 查看磁碟剩餘空間
- 每日自動更新 tracker 列表
- 超過 24 小時的檔案 / qB 任務自動清理
- 可選 WireGuard VPN（僅 qB 流量走 VPN tunnel）

## 架構

```
User (Telegram)
    │
    ▼
[Telegram Bot API Server] ← 支援 2GB 上傳
    │
    ▼
[Bot Container (TypeScript + ffmpeg)]
    ├──► [qBittorrent] → 下載
    ├──► Monitor (輪詢進度)
    ├──► Pipeline (ffmpeg 切片 / zip 分割)
    ├──► Upload → Telegram (群組 + 訊息連結)
    ├──► Upload → R2 / Filebin (背景上傳)
    └──► Stream URL → 直接從 TG 雲端串流

[Stream Server (Go + MTProto)]
    ├──► 收到 HTTP 請求
    ├──► MTProto → Telegram DC → upload.getFile
    └──► Block-by-block 串流到客戶端（支援 Range）
```

## 快速開始

```bash
cp .env.example .env
# 編輯 .env 填入設定
docker compose up -d
```

## Stream Server

Stream server 是獨立的 Go 容器，透過 MTProto 直接從 Telegram 雲端串流檔案。完全無狀態、零本地快取。

URL 格式：`/stream/{chat_id}/{message_id}/{filename}?hash=xxx`

所有資訊編碼在 URL 裡，HMAC-SHA256 防篡改。stream server 只需要：
- Telegram Bot Token + API credentials（連接 MTProto）
- 與 bot 共用的 `STREAM_SECRET`

### 同機部署

已包含在 `docker-compose.yml` 中，設定 `STREAM_HOST` 即啟用。

### 獨立部署（任意主機）

```bash
docker compose -f docker-compose.stream.yml up -d
```

#### 搭配 Cloudflare Tunnel

```bash
CLOUDFLARED_TOKEN=your-token docker compose -f docker-compose.stream.yml --profile tunnel up -d
```

`STREAM_HOST` 設為 tunnel domain（如 `https://stream.yourdomain.com`）。

## VPN 模式（可選）

只讓 qBittorrent 走 WireGuard VPN tunnel，bot 和 telegram-bot-api 走正常網路。

```
┌─────────────────────────────────────┐
│ wireguard (VPN tunnel)              │
│   └── qbittorrent (network_mode)   │  ← 只有 torrent 流量走 VPN
│       port 6891 exposed via wg      │
└────────────┬────────────────────────┘
             │ Docker internal network
┌────────────┴────────────────────────┐
│ bot ──→ wireguard:8080 (qB WebUI)   │  ← 正常網路
│ telegram-bot-api ──→ Telegram API   │
│ stream ──→ Telegram DC (MTProto)    │
│ qb-proxy ──→ 8080 (外部 WebUI)     │
│ stream-proxy ──→ 8082 (外部串流)    │
└─────────────────────────────────────┘
```

```bash
# 1. 複製並編輯 WireGuard 設定
cp data/wireguard/wg0.conf.example data/wireguard/wg0.conf

# 2. 啟動
docker compose -f docker-compose.yml -f docker-compose.vpn.yml up -d
```

## 環境變數

| 變數 | 說明 |
|------|------|
| `BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_API_ID` | 從 https://my.telegram.org 取得 |
| `TELEGRAM_API_HASH` | 從 https://my.telegram.org 取得 |
| `ALLOWED_USER_IDS` | 允許使用的 Telegram User ID（逗號分隔） |
| `ALLOWED_CHAT_IDS` | 允許使用的群組 Chat ID（逗號分隔） |
| `UPLOAD_CHAT_ID` | 檔案上傳目標群組 ID |
| `QB_HOST` | qBittorrent 主機（預設 `localhost`） |
| `QB_PORT` | qBittorrent Web UI 埠（預設 `8080`） |
| `QB_USERNAME` | qBittorrent 帳號（預設 `admin`） |
| `QB_PASSWORD` | qBittorrent 密碼 |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_ACCESS_KEY_ID` | R2 Access Key |
| `R2_SECRET_ACCESS_KEY` | R2 Secret Key |
| `R2_BUCKET_NAME` | R2 Bucket 名稱 |
| `R2_PUBLIC_URL` | R2 公開 URL（選填） |
| `STREAM_HOST` | Stream server 公開 URL（如 `http://ip:8082`） |
| `STREAM_SECRET` | Stream URL 簽名密鑰（bot 與 stream 共用） |
| `STREAM_API_KEY` | Stream API key（選填） |
| `SPLIT_TARGET_SIZE_MB` | 分割大小上限（預設 `1950` MB） |
| `CLEANUP_MAX_AGE_HOURS` | 自動清理時間（預設 `24` 小時） |
| `CLEANUP_INTERVAL_MINUTES` | 清理檢查間隔（預設 `5` 分鐘） |

## R2 設定

在 Cloudflare Dashboard 的 R2 Bucket 設定 Lifecycle Rule：

- 條件：所有物件
- 動作：1 天後刪除

## 開發

```bash
cd bot
npm install
npm run dev
```

## License

MIT
