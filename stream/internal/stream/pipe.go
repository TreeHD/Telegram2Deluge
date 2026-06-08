package stream

import (
	"context"
	"fmt"
	"io"
	"sync"

	"github.com/celestix/gotgproto"
	"github.com/gotd/td/tg"
)

const (
	defaultBlockSize = 1024 * 1024      // 1MB
	firstBlockSize   = 256 * 1024       // 256KB for fast TTFB
)

type Pipe struct {
	ctx    context.Context
	cancel context.CancelFunc
	client *gotgproto.Client

	location tg.InputFileLocationClass
	start    int64
	end      int64

	blockQueue chan []byte

	currentBlock []byte
	blockOffset  int64
	bytesRead    int64
	totalBytes   int64

	closeOnce sync.Once
}

func NewPipe(ctx context.Context, client *gotgproto.Client, location tg.InputFileLocationClass, start, end int64) (io.ReadCloser, error) {
	if start > end {
		return nil, fmt.Errorf("invalid range: start (%d) > end (%d)", start, end)
	}

	ctx, cancel := context.WithCancel(ctx)
	totalBytes := end - start + 1

	p := &Pipe{
		ctx:        ctx,
		cancel:     cancel,
		client:     client,
		location:   location,
		start:      start,
		end:        end,
		totalBytes: totalBytes,
		blockQueue: make(chan []byte, 8),
	}

	go p.prefetch()
	return p, nil
}

func (p *Pipe) Read(buf []byte) (n int, err error) {
	if p.bytesRead >= p.totalBytes {
		return 0, io.EOF
	}

	if p.blockOffset >= int64(len(p.currentBlock)) {
		select {
		case block, ok := <-p.blockQueue:
			if !ok {
				if p.bytesRead >= p.totalBytes {
					return 0, io.EOF
				}
				return 0, io.ErrUnexpectedEOF
			}
			p.currentBlock = block
			p.blockOffset = 0
		case <-p.ctx.Done():
			return 0, p.ctx.Err()
		}
	}

	n = copy(buf, p.currentBlock[p.blockOffset:])
	p.blockOffset += int64(n)
	p.bytesRead += int64(n)
	return n, nil
}

func (p *Pipe) Close() error {
	p.closeOnce.Do(func() {
		p.cancel()
	})
	return nil
}

func (p *Pipe) prefetch() {
	defer close(p.blockQueue)

	sent := int64(0)
	offset := p.start - (p.start % firstBlockSize)
	skipBytes := p.start - offset

	isFirst := true
	for sent < p.totalBytes {
		select {
		case <-p.ctx.Done():
			return
		default:
		}

		blockSize := defaultBlockSize
		if isFirst {
			blockSize = firstBlockSize
			isFirst = false
		}

		data, err := p.downloadBlockSize(offset, int64(blockSize))
		if err != nil {
			return
		}

		// Skip leading bytes on first block (alignment)
		if skipBytes > 0 {
			if skipBytes >= int64(len(data)) {
				offset += int64(blockSize)
				skipBytes -= int64(len(data))
				continue
			}
			data = data[skipBytes:]
			skipBytes = 0
		}

		// Trim trailing bytes if we'd overshoot
		remaining := p.totalBytes - sent
		if int64(len(data)) > remaining {
			data = data[:remaining]
		}

		select {
		case p.blockQueue <- data:
		case <-p.ctx.Done():
			return
		}

		sent += int64(len(data))
		offset += int64(blockSize)
	}
}

func (p *Pipe) downloadBlockSize(offset, blockSize int64) ([]byte, error) {
	res, err := p.client.API().UploadGetFile(p.ctx, &tg.UploadGetFileRequest{
		Offset:   offset,
		Limit:    int(blockSize),
		Location: p.location,
	})
	if err != nil {
		return nil, err
	}

	switch result := res.(type) {
	case *tg.UploadFile:
		return result.Bytes, nil
	default:
		return nil, fmt.Errorf("unexpected response type: %T", res)
	}
}
