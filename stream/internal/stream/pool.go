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
	"github.com/celestix/gotgproto/storage"
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

	// A fresh MTProto session has no peer records. Load dialogs to obtain and
	// persist the upload channel's access hash before serving requests.
	if cfg.UploadChat != 0 {
		pool.resolveChannel(cfg.UploadChat)
	}

	return pool, nil
}

func (p *WorkerPool) resolveChannel(chatID int64) {
	// Strip -100 prefix
	channelID := chatID
	if channelID < 0 {
		s := fmt.Sprintf("%d", -channelID)
		if len(s) > 3 && s[:3] == "100" {
			fmt.Sscanf(s[3:], "%d", &channelID)
		}
	}

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

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// PeerStorage is empty on first startup. Telegram includes channel access
	// hashes in messages.getDialogs, so use that response to seed the storage.
	for i, worker := range p.workers {
		dialogs, err := worker.Client.API().MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{
			Limit:      100,
			OffsetPeer: &tg.InputPeerEmpty{},
		})
		if err != nil {
			log.Printf("[pool] Worker %d could not load dialogs: %v", i, err)
			continue
		}

		modified, ok := dialogs.AsModified()
		if !ok {
			continue
		}
		for _, chat := range modified.GetChats() {
			channel, ok := chat.(*tg.Channel)
			if !ok || channel.ID != channelID || channel.AccessHash == 0 {
				continue
			}

			worker.Client.PeerStorage.AddPeer(channel.ID, channel.AccessHash, storage.TypeChannel, channel.Username)
			setAccessHash(channelID, channel.AccessHash)
			log.Printf("[pool] Resolved channel %d from worker %d dialogs", channelID, i)
			return
		}
	}

	log.Printf("[pool] Could not find channel %d with a non-zero access hash; ensure the bot is a member of UPLOAD_CHAT_ID", channelID)
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
