package stream

import (
	"context"
	"fmt"
	"log"

	"github.com/celestix/gotgproto"
	"github.com/gotd/td/tg"
)

func ResolveFileLocation(ctx context.Context, client *gotgproto.Client, chatID int64, messageID int) (tg.InputFileLocationClass, int64, error) {
	if chatID == 0 || messageID == 0 {
		return nil, 0, fmt.Errorf("invalid chat_id=%d or message_id=%d", chatID, messageID)
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

	// Try to get access hash from peer storage
	peer := client.PeerStorage.GetInputPeerById(chatID)
	switch p := peer.(type) {
	case *tg.InputPeerChannel:
		inputChannel.AccessHash = p.AccessHash
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
