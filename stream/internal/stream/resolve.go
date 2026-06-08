package stream

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/celestix/gotgproto"
	"github.com/gotd/td/tg"
)

var (
	accessHashCache = make(map[int64]int64)
	accessHashMu    sync.RWMutex

	locationCache   = make(map[int]cachedLocation)
	locationCacheMu sync.RWMutex
)

type cachedLocation struct {
	location tg.InputFileLocationClass
	size     int64
	cachedAt time.Time
}

const locationCacheTTL = 30 * time.Minute

func getCachedLocation(messageID int) (tg.InputFileLocationClass, int64, bool) {
	locationCacheMu.RLock()
	defer locationCacheMu.RUnlock()
	c, ok := locationCache[messageID]
	if !ok {
		return nil, 0, false
	}
	if time.Since(c.cachedAt) > locationCacheTTL {
		return nil, 0, false
	}
	return c.location, c.size, true
}

func setCachedLocation(messageID int, location tg.InputFileLocationClass, size int64) {
	locationCacheMu.Lock()
	defer locationCacheMu.Unlock()
	locationCache[messageID] = cachedLocation{location: location, size: size, cachedAt: time.Now()}
}

func init() {
	go func() {
		for {
			time.Sleep(10 * time.Minute)
			locationCacheMu.Lock()
			for k, v := range locationCache {
				if time.Since(v.cachedAt) > locationCacheTTL {
					delete(locationCache, k)
				}
			}
			locationCacheMu.Unlock()
		}
	}()
}

func getAccessHash(channelID int64) (int64, bool) {
	accessHashMu.RLock()
	defer accessHashMu.RUnlock()
	h, ok := accessHashCache[channelID]
	return h, ok
}

func setAccessHash(channelID, accessHash int64) {
	accessHashMu.Lock()
	defer accessHashMu.Unlock()
	accessHashCache[channelID] = accessHash
}

func ResolveFileLocation(ctx context.Context, client *gotgproto.Client, chatID int64, messageID int) (tg.InputFileLocationClass, int64, error) {
	if chatID == 0 || messageID == 0 {
		return nil, 0, fmt.Errorf("invalid chat_id=%d or message_id=%d", chatID, messageID)
	}

	// Check location cache first
	if loc, size, ok := getCachedLocation(messageID); ok {
		return loc, size, nil
	}

	// Strip -100 prefix for channel ID
	channelID := chatID
	if channelID < 0 {
		s := fmt.Sprintf("%d", -channelID)
		if len(s) > 3 && s[:3] == "100" {
			fmt.Sscanf(s[3:], "%d", &channelID)
		}
	}

	inputChannel := &tg.InputChannel{
		ChannelID: channelID,
	}

	// Try cached access hash first
	if h, ok := getAccessHash(channelID); ok {
		inputChannel.AccessHash = h
	} else {
		// Try peer storage
		peer := client.PeerStorage.GetInputPeerById(chatID)
		switch p := peer.(type) {
		case *tg.InputPeerChannel:
			inputChannel.AccessHash = p.AccessHash
			setAccessHash(channelID, p.AccessHash)
		}
	}

	// If no access hash, try resolving via all workers' peer storage won't work for private channels
	// Instead, try sending getMessages — if one worker has it cached, use that hash
	if inputChannel.AccessHash == 0 {
		log.Printf("[stream] Warning: no access hash for channel %d, attempting anyway", channelID)
	}

	msgID := tg.InputMessageClass(&tg.InputMessageID{ID: messageID})
	res, err := client.API().ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{
		Channel: inputChannel,
		ID:      []tg.InputMessageClass{msgID},
	})
	if err != nil {
		return nil, 0, fmt.Errorf("failed to get message: %w", err)
	}

	msgs, ok := res.(*tg.MessagesChannelMessages)
	if !ok {
		return nil, 0, fmt.Errorf("unexpected response type: %T", res)
	}
	if len(msgs.Messages) == 0 {
		return nil, 0, fmt.Errorf("message not found")
	}

	msg, ok := msgs.Messages[0].(*tg.Message)
	if !ok {
		return nil, 0, fmt.Errorf("message is not a regular message")
	}

	location, size, err := extractDocumentLocation(msg)
	if err != nil {
		return nil, 0, err
	}

	log.Printf("[stream] Resolved: chatID=%d msgID=%d size=%d", chatID, messageID, size)
	setCachedLocation(messageID, location, size)
	return location, size, nil
}

func extractDocumentLocation(msg *tg.Message) (tg.InputFileLocationClass, int64, error) {
	if msg.Media == nil {
		return nil, 0, fmt.Errorf("message has no media")
	}

	switch media := msg.Media.(type) {
	case *tg.MessageMediaDocument:
		doc, ok := media.Document.AsNotEmpty()
		if !ok {
			return nil, 0, fmt.Errorf("document is empty")
		}
		return doc.AsInputDocumentFileLocation(), doc.Size, nil
	default:
		return nil, 0, fmt.Errorf("unsupported media type: %T", media)
	}
}
