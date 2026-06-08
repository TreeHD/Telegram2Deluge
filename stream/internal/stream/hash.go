package stream

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

func GenerateHash(secret string, messageID int, filename string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d:%s", messageID, filename)))
	return hex.EncodeToString(mac.Sum(nil))[:16]
}

func VerifyHash(secret string, messageID int, filename, hash string) bool {
	return hash == GenerateHash(secret, messageID, filename)
}
