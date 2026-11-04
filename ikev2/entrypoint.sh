#!/bin/sh
set -eu

: "${IKEV2_SERVER:?Set IKEV2_SERVER to the VPN server IPv4 address}"
: "${IKEV2_REMOTE_ID:?Set IKEV2_REMOTE_ID to the name in the VPN server certificate}"
: "${IKEV2_USERNAME:?Set IKEV2_USERNAME}"
: "${IKEV2_PASSWORD:?Set IKEV2_PASSWORD}"

case "$IKEV2_SERVER" in
  *[!0-9.]*|'') echo 'IKEV2_SERVER must be an IPv4 address' >&2; exit 1 ;;
esac
if ! ip -4 route get "$IKEV2_SERVER" >/dev/null 2>&1; then
  echo 'IKEV2_SERVER must be a reachable IPv4 address' >&2
  exit 1
fi
for value in "$IKEV2_REMOTE_ID" "$IKEV2_USERNAME" "$IKEV2_PASSWORD"; do
  case "$value" in
    *'
'*) echo 'IKEv2 settings cannot contain newlines' >&2; exit 1 ;;
  esac
done

wan_if=$(ip -4 route get "$IKEV2_SERVER" | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n 1)
local_net=$(ip -4 route show dev "$wan_if" scope link | awk 'NR == 1 {print $1}')
if [ -z "$wan_if" ] || [ -z "$local_net" ]; then
  echo 'Could not determine the Docker network for IKEv2' >&2
  exit 1
fi

# Block all ordinary outbound traffic in the shared qBittorrent network namespace.
# IPsec-protected packets match the policy rule; IKE and local WebUI traffic are exceptions.
iptables -P OUTPUT DROP
iptables -A OUTPUT -d 127.0.0.11 -p udp --dport 53 -j REJECT
iptables -A OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j REJECT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -o "$wan_if" -d "$local_net" -j ACCEPT
iptables -A OUTPUT -o "$wan_if" -d "$IKEV2_SERVER" -p udp -m multiport --dports 500,4500 -j ACCEPT
iptables -A OUTPUT -m policy --dir out --pol ipsec -j ACCEPT

# Keep Docker service traffic and the IKE exchange off strongSwan's full-tunnel route.
ip route replace throw "$local_net" table 220
ip route replace throw "$IKEV2_SERVER" table 220

quote_swanctl() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

umask 077
mkdir -p /run/ikev2/x509ca
cp -L /etc/ssl/certs/*.pem /run/ikev2/x509ca/
if [ -f /etc/ikev2/ca.crt ]; then
  cp /etc/ikev2/ca.crt /run/ikev2/x509ca/vpn-ca.crt
fi

cat > /run/ikev2/swanctl.conf <<EOF
connections {
  vpn {
    version = 2
    remote_addrs = $IKEV2_SERVER
    vips = 0.0.0.0
    dpd_delay = 30s
    local {
      auth = eap-mschapv2
      eap_id = "$(quote_swanctl "$IKEV2_USERNAME")"
    }
    remote {
      auth = pubkey
      id = "$(quote_swanctl "$IKEV2_REMOTE_ID")"
    }
    children {
      net {
        local_ts = dynamic
        remote_ts = 0.0.0.0/0
        dpd_action = restart
        close_action = restart
      }
    }
  }
}
secrets {
  eap-user {
    id = "$(quote_swanctl "$IKEV2_USERNAME")"
    secret = "$(quote_swanctl "$IKEV2_PASSWORD")"
  }
}
EOF

charon-systemd &
daemon_pid=$!
trap 'kill "$daemon_pid" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true' INT TERM EXIT

until swanctl --list-conns >/dev/null 2>&1; do
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    echo 'strongSwan exited before loading the VPN configuration' >&2
    exit 1
  fi
  sleep 1
done
swanctl --load-all --file /run/ikev2/swanctl.conf --noprompt

while kill -0 "$daemon_pid" 2>/dev/null; do
  if ! swanctl --list-sas 2>/dev/null | grep -q 'INSTALLED'; then
    swanctl --initiate --child net --timeout 10 || true
  fi
  sleep 10
done
echo 'strongSwan exited' >&2
exit 1
