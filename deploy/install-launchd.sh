#!/bin/sh
# Installs (or refreshes) a macOS LaunchAgent that keeps the watcher running.
# Usage: deploy/install-launchd.sh [label]
set -eu

LABEL="${1:-com.whatsapp-claude-tag}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/whatsapp-claude-tag"
NODE_DIR="$(dirname "$(command -v node)")"
CLAUDE_DIR="$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)")"

mkdir -p "$LOGS" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$HERE/deploy/start.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:$CLAUDE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ExitTimeOut</key><integer>330</integer>
  <key>StandardOutPath</key><string>$LOGS/out.log</string>
  <key>StandardErrorPath</key><string>$LOGS/err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $PLIST"
echo "logs: $LOGS/out.log"
