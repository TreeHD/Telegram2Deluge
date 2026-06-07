FROM golang:latest AS builder

WORKDIR /build

COPY go.mod ./
COPY main.go ./
COPY internal/ ./internal/

RUN go mod tidy
RUN CGO_ENABLED=1 go build -o /build/tg-stream .

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/tg-stream .

CMD ["./tg-stream"]
