FROM golang:1.23-alpine AS builder

RUN apk add --no-cache gcc musl-dev

WORKDIR /build

COPY go.mod ./
COPY main.go ./
COPY internal/ ./internal/

RUN go mod tidy
RUN CGO_ENABLED=1 go build -o /build/tg-stream .

FROM alpine:3.20

RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=builder /build/tg-stream .

CMD ["./tg-stream"]
