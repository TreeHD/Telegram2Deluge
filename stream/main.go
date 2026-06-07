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
	"tg-stream/internal/db"
	"tg-stream/internal/stream"

	"github.com/celestix/gotgproto"
	"github.com/celestix/gotgproto/sessionMaker"
	"github.com/glebarez/sqlite"
)

var (
	cfg      *config.Config
	database *db.DB
	client   *gotgproto.Client
)

func main() {
	cfg = config.Load()

	var err error
	database, err = db.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer database.Close()

	log.Println("Connecting to Telegram...")
	client, err = gotgproto.NewClient(
		int(cfg.ApiID),
		cfg.ApiHash,
		gotgproto.ClientTypeBot(cfg.BotToken),
		&gotgproto.ClientOpts{
			Session:          sessionMaker.SqlSession(sqlite.Open("stream.session")),
			DisableCopyright: true,
		},
	)
	if err != nil {
		log.Fatalf("Failed to start Telegram client: %v", err)
	}
	log.Printf("Telegram client started as @%s", client.Self.Username)

	mux := http.NewServeMux()
	mux.HandleFunc("/stream/", handleStream)

	addr := fmt.Sprintf(":%d", cfg.StreamPort)
	log.Printf("Stream server listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

func handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse /stream/{jobId}/{filename}
	trimmed := strings.TrimPrefix(r.URL.Path, "/stream/")
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	jobID := parts[0]
	filename, _ := url.PathUnescape(parts[1])
	hash := r.URL.Query().Get("hash")

	if !stream.VerifyHash(cfg.Secret, jobID, filename, hash) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// Virtual m3u8
	if filename == "playlist.m3u8" {
		handleM3u8(w, r, jobID)
		return
	}

	// Lookup file in DB
	file, err := database.GetStreamFile(jobID, filename)
	if err != nil {
		http.Error(w, "File Not Found", http.StatusNotFound)
		return
	}

	// Resolve from Telegram
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	location, fileSize, err := stream.ResolveFileLocation(ctx, client, file)
	if err != nil {
		log.Printf("[stream] Resolve error: %v", err)
		http.Error(w, "File Not Available", http.StatusNotFound)
		return
	}

	if fileSize == 0 {
		fileSize = file.FileSize
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

func handleM3u8(w http.ResponseWriter, r *http.Request, jobID string) {
	files, err := database.GetStreamFiles(jobID)
	if err != nil || len(files) == 0 {
		http.Error(w, "No playlist available", http.StatusNotFound)
		return
	}

	videoExts := map[string]bool{
		".mp4": true, ".mkv": true, ".m4v": true,
		".ts": true, ".avi": true, ".mov": true, ".webm": true,
	}

	var videos []db.StreamFile
	for _, f := range files {
		ext := strings.ToLower(path.Ext(f.Filename))
		if videoExts[ext] {
			videos = append(videos, f)
		}
	}

	if len(videos) <= 1 {
		http.Error(w, "No playlist available", http.StatusNotFound)
		return
	}

	var sb strings.Builder
	sb.WriteString("#EXTM3U\n")
	for _, v := range videos {
		hash := stream.GenerateHash(cfg.Secret, jobID, v.Filename)
		fileURL := fmt.Sprintf("%s/stream/%s/%s?hash=%s", cfg.StreamHost, jobID, url.PathEscape(v.Filename), hash)
		sb.WriteString(fmt.Sprintf("#EXTINF:-1,%s\n", v.Filename))
		sb.WriteString(fileURL + "\n")
	}

	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Content-Disposition", `inline; filename="playlist.m3u8"`)
	w.WriteHeader(http.StatusOK)
	if r.Method != "HEAD" {
		w.Write([]byte(sb.String()))
	}
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
		// suffix range: -500
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
