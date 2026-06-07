package stream

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

func GenerateHash(secret, jobID, filename string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(jobID + ":" + filename))
	return hex.EncodeToString(mac.Sum(nil))[:16]
}

func VerifyHash(secret, jobID, filename, hash string) bool {
	return hash == GenerateHash(secret, jobID, filename)
}
