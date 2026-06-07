package stream

import (
	"context"
	"fmt"
	"io"
	"sync"

	"github.com/celestix/gotgproto"
	"github.com/gotd/td/tg"
)

const defaultBlockSize = 1024 * 1024 // 1MB

type Pipe struct {
	ctx    context.Context
	cancel context.CancelFunc
	client *gotgproto.Client

	location tg.InputFileLocationClass
	start    int64
	end      int64

	blockSize  int64
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
		blockSize:  defaultBlockSize,
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

	alignedStart := p.start - (p.start % p.blockSize)
	leftTrim := p.start - alignedStart
	rightTrim := (p.end % p.blockSize) + 1
	totalBlocks := int((p.end - alignedStart + p.blockSize) / p.blockSize)

	offset := alignedStart

	for blockNum := 0; blockNum < totalBlocks; blockNum++ {
		select {
		case <-p.ctx.Done():
			return
		default:
		}

		data, err := p.downloadBlock(offset)
		if err != nil {
			if p.ctx.Err() != nil {
				return
			}
			return
		}

		dataLen := int64(len(data))

		if totalBlocks == 1 {
			if dataLen < rightTrim {
				rightTrim = dataLen
			}
			if leftTrim > dataLen {
				leftTrim = dataLen
			}
			data = data[leftTrim:rightTrim]
		} else if blockNum == 0 {
			if leftTrim > dataLen {
				leftTrim = dataLen
			}
			data = data[leftTrim:]
		} else if blockNum == totalBlocks-1 {
			if dataLen > rightTrim {
				data = data[:rightTrim]
			}
		}

		select {
		case p.blockQueue <- data:
		case <-p.ctx.Done():
			return
		}

		offset += p.blockSize
	}
}

func (p *Pipe) downloadBlock(offset int64) ([]byte, error) {
	res, err := p.client.API().UploadGetFile(p.ctx, &tg.UploadGetFileRequest{
		Offset:   offset,
		Limit:    int(p.blockSize),
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
