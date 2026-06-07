package stream

import (
	"context"
	"fmt"
	"log"
	"tg-stream/internal/db"

	"github.com/celestix/gotgproto"
	"github.com/gotd/td/tg"
)

func ResolveFileLocation(ctx context.Context, client *gotgproto.Client, file *db.StreamFile) (tg.InputFileLocationClass, int64, error) {
	// Get channel input peer from chat ID
	chatID := file.ChatID
	if chatID == 0 {
		return nil, 0, fmt.Errorf("chat_id is 0")
	}

	// Strip -100 prefix for channel ID
	channelID := chatID
	if channelID < 0 {
		s := fmt.Sprintf("%d", -channelID)
		if len(s) > 3 && s[:3] == "100" {
			s = s[3:]
			fmt.Sscanf(s, "%d", &channelID)
		}
	}

	inputChannel := &tg.InputChannel{
		ChannelID: channelID,
	}

	// Try to get access hash from peer storage
	peer := client.PeerStorage.GetInputPeerById(chatID)
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		inputChannel.AccessHash = p.AccessHash
	}

	msgID := tg.InputMessageClass(&tg.InputMessageID{ID: file.MessageID})
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

	log.Printf("[stream] Resolved: chatID=%d msgID=%d size=%d", chatID, file.MessageID, size)
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
	case *tg.MessageMediaPhoto:
		return nil, 0, fmt.Errorf("photo streaming not supported")
	default:
		return nil, 0, fmt.Errorf("unsupported media type: %T", media)
	}
}
