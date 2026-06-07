# TGTransmission

Telegram Bot 串接 qBittorrent，自動下載種子並上傳到 Telegram + Cloudflare R2。

## 功能

- 傳送 `.torrent` 檔案、磁力鏈結或 URL 給 Bot，自動加入 qBittorrent 下載
- 下載進度即時更新（每 15 秒編輯訊息 + 進度條）
- 影片超過 2GB 先 ffmpeg 壓縮，壓不下來才 zip 分割
- 非影片超過 2GB 自動 zip 分割
- 上傳到指定群組，原訊息顯示檔案超連結清單
- 可選上傳到 Cloudflare R2，產生 24 小時有效的下載連結
- 每日自動更新 tracker 列表
- 超過 24 小時的檔案 / qB 任務自動清理
- 可選 WireGuard VPN（qB 流量走 VPN tunnel）
- `/status` 查看下載進度
- `/disk` 查看磁碟剩餘空間

## 架構

```
User (Telegram)
    │
    ▼
[Telegram Bot API Server] ← 支援 2GB 上傳
    │
    ▼
[Bot Container (TypeScript + ffmpeg)]
    ├──► [qBittorrent] → 下載到共享 volume
    ├──► Monitor (每 5 秒輪詢，15 秒更新進度)
    ├──► Pipeline (ffmpeg 壓縮 / zip 分割)
    ├──► Upload → Telegram (指定群組 + 訊息連結)
    └──► Upload → Cloudflare R2 (presigned URL, 24hr)

所有服務共用 qBittorrent 的 network namespace (localhost 互通)
```

## 快速開始

```bash
cp .env.example .env
# 編輯 .env 填入設定
docker compose up -d
```

## VPN 模式（可選）

只讓 qBittorrent 走 WireGuard VPN tunnel，bot 和 telegram-bot-api 走正常網路（節省 VPN 流量）。

```
┌─────────────────────────────────────┐
│ wireguard (VPN tunnel)              │
│   └── qbittorrent (network_mode)   │  ← 只有 torrent 流量走 VPN
│       port 6891 exposed via wg      │
└────────────┬────────────────────────┘
             │ Docker internal network
┌────────────┴────────────────────────┐
│ bot ──→ wireguard:8080 (qB WebUI)   │  ← 正常網路
│ bot ──→ telegram-bot-api:8081       │
│ telegram-bot-api ──→ Telegram API   │
└─────────────────────────────────────┘
```

```bash
# 1. 複製並編輯 WireGuard 設定
cp data/wireguard/wg0.conf.example data/wireguard/wg0.conf
# 填入你的 VPN server 資訊

# 2. 啟動時加上 VPN overlay
docker compose -f docker-compose.yml -f docker-compose.vpn.yml up -d
```

**注意事項：**
- VPN server 必須 port forward 6891 TCP+UDP 到 client VPN IP
- 只有 qBittorrent 流量走 VPN，Telegram 上傳/下載走正常網路
- 範例 config 含 kill switch（VPN 斷線時阻擋 qB 流量防止 IP 洩漏）
- healthcheck 確保 WireGuard 連線成功後才啟動 qBittorrent
- VPN 模式下 bot 會自動改用 `wireguard:8080` 連 qB、`telegram-bot-api:8081` 連 TG API

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
| `R2_PUBLIC_URL` | R2 公開 URL（選填，有的話用直連而非 presigned） |
| `SPLIT_TARGET_SIZE_MB` | 分割大小上限（預設 `1950` MB） |
| `CLEANUP_MAX_AGE_HOURS` | 自動清理時間（預設 `24` 小時） |
| `CLEANUP_INTERVAL_MINUTES` | 清理檢查間隔（預設 `5` 分鐘） |

## R2 設定

在 Cloudflare Dashboard 的 R2 Bucket 設定 Lifecycle Rule：

- 條件：所有物件
- 動作：1 天後刪除

這樣上傳的檔案會在 24 小時後自動清除。

## 開發

```bash
cd bot
npm install
npm run dev
```

## License

MIT
