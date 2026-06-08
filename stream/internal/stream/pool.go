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
	pool.resolveDialogs()

	return pool, nil
}

func (p *WorkerPool) resolveDialogs() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client := p.workers[0].Client
	res, err := client.API().MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{
		OffsetPeer: &tg.InputPeerEmpty{},
		Limit:      100,
	})
	if err != nil {
		log.Printf("[pool] Failed to load dialogs: %v", err)
		return
	}

	switch d := res.(type) {
	case *tg.MessagesDialogs:
		for _, chat := range d.Chats {
			if ch, ok := chat.(*tg.Channel); ok {
				setAccessHash(ch.ID, ch.AccessHash)
				log.Printf("[pool] Cached channel: %d (%s)", ch.ID, ch.Title)
			}
		}
	case *tg.MessagesDialogsSlice:
		for _, chat := range d.Chats {
			if ch, ok := chat.(*tg.Channel); ok {
				setAccessHash(ch.ID, ch.AccessHash)
				log.Printf("[pool] Cached channel: %d (%s)", ch.ID, ch.Title)
			}
		}
	}
}

func (p *WorkerPool) Next() *gotgproto.Client {
	idx := atomic.AddUint64(&p.index, 1)
	worker := p.workers[idx%uint64(len(p.workers))]
	return worker.Client
}

func (p *WorkerPool) Size() int {
	return len(p.workers)
}
