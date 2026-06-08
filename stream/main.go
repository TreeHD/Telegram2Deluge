package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"tg-stream/internal/config"
	"tg-stream/internal/stream"

	"github.com/celestix/gotgproto"
	"github.com/celestix/gotgproto/sessionMaker"
	"github.com/glebarez/sqlite"
)

var (
	cfg    *config.Config
	client *gotgproto.Client
)

func main() {
	cfg = config.Load()

	log.Printf("Connecting to Telegram (apiID=%d)...", cfg.ApiID)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		var err error
		client, err = gotgproto.NewClient(
			int(cfg.ApiID),
			cfg.ApiHash,
			gotgproto.ClientTypeBot(cfg.BotToken),
			&gotgproto.ClientOpts{
				Session:          sessionMaker.SqlSession(sqlite.Open(cfg.SessionPath)),
				DisableCopyright: true,
			},
		)
		done <- err
	}()

	select {
	case err := <-done:
		if err != nil {
			log.Fatalf("Failed to start Telegram client: %v", err)
		}
	case <-ctx.Done():
		log.Fatalf("Timeout connecting to Telegram (120s)")
	}

	log.Printf("Telegram client started as @%s", client.Self.Username)

	mux := http.NewServeMux()
	mux.HandleFunc("/stream/", handleStream)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	addr := fmt.Sprintf(":%d", cfg.StreamPort)
	log.Printf("Stream server listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

// URL format: /stream/{chat_id}/{message_id}/{filename}?hash=xxx
func handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	trimmed := strings.TrimPrefix(r.URL.Path, "/stream/")
	parts := strings.SplitN(trimmed, "/", 3)
	if len(parts) < 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	chatID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		http.Error(w, "Invalid chat_id", http.StatusBadRequest)
		return
	}
	messageID, err := strconv.Atoi(parts[1])
	if err != nil {
		http.Error(w, "Invalid message_id", http.StatusBadRequest)
		return
	}
	filename, _ := url.PathUnescape(parts[2])
	hash := r.URL.Query().Get("hash")

	if !stream.VerifyHash(cfg.Secret, chatID, messageID, filename, hash) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// Resolve from Telegram via MTProto
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	location, fileSize, err := stream.ResolveFileLocation(ctx, client, chatID, messageID)
	if err != nil {
		log.Printf("[stream] Resolve error: chatID=%d msgID=%d err=%v", chatID, messageID, err)
		http.Error(w, "File Not Available", http.StatusNotFound)
		return
	}

	mimeType := getMimeType(filename)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, url.PathEscape(filename)))
	w.Header().Set("Content-Type", mimeType)

	var start, end int64

	rangeHeader := r.Header.Get("Range")
	if rangeHeader == "" {
		start = 0
		end = fileSize - 1
		w.Header().Set("Content-Length", strconv.FormatInt(fileSize, 10))
		w.WriteHeader(http.StatusOK)
	} else {
		ranges := parseRange(rangeHeader, fileSize)
		if ranges == nil {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", fileSize))
			http.Error(w, "Range Not Satisfiable", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		start = ranges[0]
		end = ranges[1]
		contentLength := end - start + 1
		w.Header().Set("Content-Length", strconv.FormatInt(contentLength, 10))
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, fileSize))
		w.WriteHeader(http.StatusPartialContent)
	}

	if r.Method == "HEAD" {
		return
	}

	pipe, err := stream.NewPipe(r.Context(), client, location, start, end)
	if err != nil {
		log.Printf("[stream] Pipe error: %v", err)
		return
	}
	defer pipe.Close()

	contentLength := end - start + 1
	io.CopyN(w, pipe, contentLength)
}

func parseRange(rangeHeader string, fileSize int64) []int64 {
	if !strings.HasPrefix(rangeHeader, "bytes=") {
		return nil
	}
	rangeSpec := strings.TrimPrefix(rangeHeader, "bytes=")
	parts := strings.SplitN(rangeSpec, "-", 2)
	if len(parts) != 2 {
		return nil
	}

	var start, end int64
	var err error

	if parts[0] == "" {
		end = fileSize - 1
		suffix, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return nil
		}
		start = fileSize - suffix
	} else {
		start, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return nil
		}
		if parts[1] == "" {
			end = fileSize - 1
		} else {
			end, err = strconv.ParseInt(parts[1], 10, 64)
			if err != nil {
				return nil
			}
		}
	}

	if start < 0 || end >= fileSize || start > end {
		return nil
	}

	return []int64{start, end}
}

func getMimeType(filename string) string {
	mimeTypes := map[string]string{
		".mp4":  "video/mp4",
		".mkv":  "video/x-matroska",
		".avi":  "video/x-msvideo",
		".mov":  "video/quicktime",
		".webm": "video/webm",
		".m4v":  "video/x-m4v",
		".ts":   "video/mp2t",
		".zip":  "application/zip",
		".rar":  "application/x-rar-compressed",
		".7z":   "application/x-7z-compressed",
		".m3u8": "application/vnd.apple.mpegurl",
		".srt":  "text/plain",
		".ass":  "text/plain",
	}

	ext := strings.ToLower(path.Ext(filename))
	if mt, ok := mimeTypes[ext]; ok {
		return mt
	}
	return "application/octet-stream"
}
