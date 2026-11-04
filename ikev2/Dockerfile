FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates charon-systemd libcharon-extauth-plugins \
       libstrongswan-standard-plugins \
       iproute2 iptables strongswan-swanctl \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/ikev2-entrypoint
RUN chmod 755 /usr/local/bin/ikev2-entrypoint

ENTRYPOINT ["/usr/local/bin/ikev2-entrypoint"]
