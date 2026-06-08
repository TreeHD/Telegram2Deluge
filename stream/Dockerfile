FROM golang:latest AS builder

WORKDIR /build

# Deps layer (cached unless go.mod changes)
COPY go.mod ./
COPY main.go ./
COPY internal/ ./internal/
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod tidy

# Build layer (cached unless source changes)
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 go build -o /build/tg-stream .

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/tg-stream .

CMD ["./tg-stream"]
