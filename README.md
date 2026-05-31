# TGTransmission

Telegram Bot 串接 Deluge，自動下載種子並上傳到 Telegram + Cloudflare R2。

## 功能

- 傳送 `.torrent` 檔案、磁力鏈結或 URL 給 Bot，自動加入 Deluge 下載
- 下載完成後自動上傳到 Telegram（分段檔案以 reply thread 呈現）
- 超過 2GB 的檔案自動 zip 分割
- 可選上傳到 Cloudflare R2，產生 24 小時有效的下載連結
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
[Bot Container (TypeScript)]
    ├──► [Deluge Daemon] → 下載到共享 volume
    ├──► Monitor (每 5 秒輪詢進度)
    ├──► Pipeline (zip 分割)
    ├──► Upload → Telegram (reply thread)
    └──► Upload → Cloudflare R2 (presigned URL, 24hr)
```

## 快速開始

```bash
cp .env.example .env
# 編輯 .env 填入設定
docker compose up -d
```

## 環境變數

| 變數 | 說明 |
|------|------|
| `BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_API_ID` | 從 https://my.telegram.org 取得 |
| `TELEGRAM_API_HASH` | 從 https://my.telegram.org 取得 |
| `ALLOWED_USER_IDS` | 允許使用的 Telegram User ID（逗號分隔） |
| `DELUGE_HOST` | Deluge daemon 主機（預設 `deluge`） |
| `DELUGE_PORT` | Deluge daemon 埠（預設 `58846`） |
| `DELUGE_USERNAME` | Deluge 帳號（預設 `localclient`） |
| `DELUGE_PASSWORD` | Deluge 密碼 |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_ACCESS_KEY_ID` | R2 Access Key |
| `R2_SECRET_ACCESS_KEY` | R2 Secret Key |
| `R2_BUCKET_NAME` | R2 Bucket 名稱 |
| `R2_PUBLIC_URL` | R2 公開 URL（選填，有的話用直連而非 presigned） |
| `SPLIT_TARGET_SIZE_MB` | 分割大小上限（預設 `1950` MB） |

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
