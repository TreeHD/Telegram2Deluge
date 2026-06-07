package config

import (
	"os"
	"strconv"
)

type Config struct {
	ApiID      int32
	ApiHash    string
	BotToken   string
	StreamPort int
	StreamHost string
	Secret     string
	DBPath     string
	LogChannel int64
}

func Load() *Config {
	apiID, _ := strconv.Atoi(getEnv("TELEGRAM_API_ID", "0"))
	port, _ := strconv.Atoi(getEnv("STREAM_PORT", "8082"))
	logChannel, _ := strconv.ParseInt(getEnv("UPLOAD_CHAT_ID", "0"), 10, 64)

	return &Config{
		ApiID:      int32(apiID),
		ApiHash:    getEnv("TELEGRAM_API_HASH", ""),
		BotToken:   getEnv("BOT_TOKEN", ""),
		StreamPort: port,
		StreamHost: getEnv("STREAM_HOST", ""),
		Secret:     getEnv("STREAM_SECRET", ""),
		DBPath:     getEnv("DB_PATH", "/data/queue/state.db"),
		LogChannel: logChannel,
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
