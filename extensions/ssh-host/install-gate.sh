#!/bin/sh
# Run on the machine that should accept requests (the laptop). Installs the gate and
# prints the authorized_keys line for a public key, restricted to the gate.
#   extensions/ssh-host/install-gate.sh "<ssh-ed25519 AAAA... comment>" [projects root]
set -eu
PUB="$1"; ROOT="${2:-$HOME/projects}"
case "$PUB" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-*) ;; *) echo "usage: $0 '<public key line>' [root]" >&2; exit 2;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/wct-gate"
mkdir -p "$DEST" && cp "$HERE/gate.mjs" "$DEST/gate.mjs" && chmod 755 "$DEST/gate.mjs"
NODE="$(command -v node)"; CLAUDE="$(command -v claude || true)"
# Optional: TOKEN_CMD prints a Claude Code OAuth token (for example a Keychain read).
TOK=""; [ -n "${TOKEN_CMD:-}" ] && TOK="WCT_TOKEN_CMD='$TOKEN_CMD' "
echo "command=\"${TOK}WCT_ROOT=$ROOT WCT_CLAUDE=$CLAUDE $NODE $DEST/gate.mjs\",restrict $PUB"
