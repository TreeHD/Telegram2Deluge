# AGENTS.md

## Repository Overview
- `bot/`: TypeScript Telegram bot that accepts torrents/magnets/URLs, manages qBittorrent downloads, processes large files, and uploads outputs.
- `stream/`: Go MTProto streaming server that serves Telegram-hosted files through signed `/stream/{message_id}/{filename}?hash=...` URLs.
- `data/`: runtime volumes (downloads, queue, configs, WireGuard files).
- Root `docker-compose*.yml`: deployment topologies (default, standalone stream, optional WireGuard VPN routing).

## Working Rules for Agents
- Keep changes minimal and scoped to the requested task.
- Do not commit secrets or real credentials; use placeholders in docs/examples.
- Preserve existing behavior unless the task explicitly requires behavior changes.
- Prefer editing existing files over introducing new dependencies or tooling.

## Build and Validation
### Bot (`bot/`)
- Install deps: `npm install`
- Run in dev mode: `npm run dev`
- Type-check: `npm run typecheck`
- Build: `npm run build`

### Stream (`stream/`)
- Build binary: `go build ./...`

## Configuration Notes
- Main environment template is `.env.example`.
- Core required variables include Telegram credentials, qB credentials, upload chat IDs, and stream signing secret (`STREAM_SECRET`).
- Stream and bot must share the same `STREAM_SECRET` when stream links are enabled.

## Deployment Notes
- Default stack: `docker compose up -d`
- Standalone stream stack: `docker compose -f docker-compose.stream.yml up -d`
- VPN overlay mode: `docker compose -f docker-compose.yml -f docker-compose.vpn.yml up -d`

## High-Risk Areas
- File processing/splitting and upload pipeline under `bot/src/pipeline/`
- qBittorrent coordination under `bot/src/qb/` and `bot/src/monitor/`
- Signed stream URL verification and range handling in `stream/main.go`
