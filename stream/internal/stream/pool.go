package stream

import (
	"fmt"
	"log"
	"sync/atomic"

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

	// Bot accounts cannot call messages.getDialogs. A configured hash supports
	// streaming existing messages immediately after a fresh session is created.
	if cfg.UploadChatAccessHash != 0 {
		channelID := channelIDFromChatID(cfg.UploadChat)
		setAccessHash(channelID, cfg.UploadChatAccessHash)
		log.Printf("[pool] Loaded configured access hash for channel %d", channelID)
	}

	// Peer storage is also populated from new channel updates received after
	// startup, which makes future restarts work without the configured value.
	if cfg.UploadChat != 0 {
		pool.resolveChannel(cfg.UploadChat)
	}

	return pool, nil
}

func (p *WorkerPool) resolveChannel(chatID int64) {
	channelID := channelIDFromChatID(chatID)

	for i, worker := range p.workers {
		peer := worker.Client.PeerStorage.GetInputPeerById(chatID)
		switch inputPeer := peer.(type) {
		case *tg.InputPeerChannel:
			if inputPeer.AccessHash != 0 {
				setAccessHash(channelID, inputPeer.AccessHash)
				log.Printf("[pool] Resolved channel %d from worker %d peer storage (hash=%d)", channelID, i, inputPeer.AccessHash)
				return
			}
		}
	}

	log.Printf("[pool] Missing access hash for channel %d; set UPLOAD_CHAT_ACCESS_HASH to stream existing messages after a fresh session", channelID)
}

func channelIDFromChatID(chatID int64) int64 {
	channelID := chatID
	if channelID < 0 {
		s := fmt.Sprintf("%d", -channelID)
		if len(s) > 3 && s[:3] == "100" {
			fmt.Sscanf(s[3:], "%d", &channelID)
		}
	}
	return channelID
}

func (p *WorkerPool) Next() (*gotgproto.Client, int) {
	workerCount := len(p.workers)
	if workerCount == 0 {
		return nil, -1
	}

	for {
		current := atomic.LoadUint64(&p.index)
		next := current + 1
		if atomic.CompareAndSwapUint64(&p.index, current, next) {
			i := current % uint64(workerCount)
			return p.workers[i].Client, int(i)
		}
	}
}

func (p *WorkerPool) Resolver() *gotgproto.Client {
	if len(p.workers) == 0 {
		return nil
	}
	return p.workers[0].Client
}

func (p *WorkerPool) Size() int {
	return len(p.workers)
}
