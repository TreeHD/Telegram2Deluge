package config

import (
	"os"
	"strconv"
)

type Config struct {
	ApiID       int32
	ApiHash     string
	BotToken    string
	StreamPort  int
	Secret      string
	SessionPath string
	Workers     int
}

func Load() *Config {
	apiID, _ := strconv.Atoi(getEnv("TELEGRAM_API_ID", "0"))
	port, _ := strconv.Atoi(getEnv("STREAM_PORT", "8082"))
	workers, _ := strconv.Atoi(getEnv("STREAM_WORKERS", "4"))

	return &Config{
		ApiID:       int32(apiID),
		ApiHash:     getEnv("TELEGRAM_API_HASH", ""),
		BotToken:    getEnv("BOT_TOKEN", ""),
		StreamPort:  port,
		Secret:      getEnv("STREAM_SECRET", "change-me"),
		SessionPath: getEnv("SESSION_PATH", "/data/stream.session"),
		Workers:     workers,
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
