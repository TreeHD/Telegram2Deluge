package stream

import (
	"context"
	"fmt"
	"log"
	"sync/atomic"
	"time"

	"tg-stream/internal/config"

	"github.com/celestix/gotgproto"
	"github.com/celestix/gotgproto/sessionMaker"
	"github.com/glebarez/sqlite"
	"github.com/gotd/td/tg"
)

type Worker struct {
	Client *gotgproto.Client
}

type WorkerPool struct {
	workers []*Worker
	index   uint64
}

func NewWorkerPool(cfg *config.Config, count int) (*WorkerPool, error) {
	if count < 1 {
		count = 1
	}

	pool := &WorkerPool{
		workers: make([]*Worker, 0, count),
	}

	for i := 0; i < count; i++ {
		sessionPath := cfg.SessionPath
		if i > 0 {
			sessionPath = fmt.Sprintf("%s.%d", cfg.SessionPath, i)
		}

		client, err := gotgproto.NewClient(
			int(cfg.ApiID),
			cfg.ApiHash,
			gotgproto.ClientTypeBot(cfg.BotToken),
			&gotgproto.ClientOpts{
				Session:          sessionMaker.SqlSession(sqlite.Open(sessionPath)),
				DisableCopyright: true,
			},
		)
		if err != nil {
			if i == 0 {
				return nil, err
			}
			log.Printf("[pool] Worker %d failed to start: %v (continuing with %d workers)", i, err, len(pool.workers))
			break
		}

		pool.workers = append(pool.workers, &Worker{Client: client})
		log.Printf("[pool] Worker %d started as @%s", i, client.Self.Username)
	}

	// Pre-resolve peers by loading dialogs on the first worker
	if cfg.UploadChat != 0 {
		pool.resolveChannel(cfg.UploadChat)
	}

	return pool, nil
}

func (p *WorkerPool) resolveChannel(chatID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	client := p.workers[0].Client

	// Strip -100 prefix
	channelID := chatID
	if channelID < 0 {
		s := fmt.Sprintf("%d", -channelID)
		if len(s) > 3 && s[:3] == "100" {
			fmt.Sscanf(s[3:], "%d", &channelID)
		}
	}

	// First check peer storage
	peer := client.PeerStorage.GetInputPeerById(chatID)
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		if p.AccessHash != 0 {
			setAccessHash(channelID, p.AccessHash)
			log.Printf("[pool] Resolved channel %d from peer storage (hash=%d)", channelID, p.AccessHash)
			return
		}
	}

	// Try getHistory with access_hash=0 — works for bots that are channel members
	inputPeer := &tg.InputPeerChannel{ChannelID: channelID, AccessHash: 0}
	res, err := client.API().MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{
		Peer:  inputPeer,
		Limit: 1,
	})
	if err != nil {
		log.Printf("[pool] Failed to resolve channel %d via getHistory: %v", channelID, err)
		log.Printf("[pool] Trying getFullChannel...")

		// Fallback: try getFullChannel
		inputChannel := &tg.InputChannel{ChannelID: channelID, AccessHash: 0}
		fullRes, err2 := client.API().ChannelsGetFullChannel(ctx, inputChannel)
		if err2 != nil {
			log.Printf("[pool] Failed to resolve channel %d: %v", channelID, err2)
			return
		}
		for _, chat := range fullRes.Chats {
			if ch, ok := chat.(*tg.Channel); ok && ch.ID == channelID {
				setAccessHash(channelID, ch.AccessHash)
				log.Printf("[pool] Resolved channel %d via getFullChannel (hash=%d)", channelID, ch.AccessHash)
				return
			}
		}
		return
	}

	// Extract access hash from chats in the response
	switch msgs := res.(type) {
	case *tg.MessagesChannelMessages:
		for _, chat := range msgs.Chats {
			if ch, ok := chat.(*tg.Channel); ok && ch.ID == channelID {
				setAccessHash(channelID, ch.AccessHash)
				log.Printf("[pool] Resolved channel %d via getHistory (hash=%d)", channelID, ch.AccessHash)
				return
			}
		}
	}

	log.Printf("[pool] Could not find access hash for channel %d in response", channelID)
}

func (p *WorkerPool) Next() (*gotgproto.Client, int) {
	idx := atomic.AddUint64(&p.index, 1)
	i := idx % uint64(len(p.workers))
	return p.workers[i].Client, int(i)
}

func (p *WorkerPool) Size() int {
	return len(p.workers)
}
