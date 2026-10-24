#!/bin/sh
# Service entry point. Sources an optional env file (for CLAUDE_CODE_OAUTH_TOKEN,
# EVOLUTION_API_KEY, PATH) and runs the watcher in the foreground.
set -eu

ENV_FILE="${WCT_ENV_FILE:-$HOME/.config/whatsapp-claude-tag/env.sh}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$HERE/src/cli.mjs" run "$@"
