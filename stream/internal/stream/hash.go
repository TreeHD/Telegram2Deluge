package stream

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

func GenerateHash(secret string, chatID int64, messageID int, filename string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d:%d:%s", chatID, messageID, filename)))
	return hex.EncodeToString(mac.Sum(nil))[:16]
}

func VerifyHash(secret string, chatID int64, messageID int, filename, hash string) bool {
	return hash == GenerateHash(secret, chatID, messageID, filename)
}
