# Installing whatsapp-claude-tag

This guide is written to be followed by a coding agent. You can hand it to Claude Code:

> Install whatsapp-claude-tag on this machine by following INSTALL.md in https://github.com/dangogit/whatsapp-claude-tag

Steps marked **(you)** need the person at the keyboard or at their phone. Everything else an agent can run.

## Rules for the agent doing the install

- Never print, log or commit a secret: the Evolution API key, the Postgres password, the Claude token. Write them to files with mode `600`.
- Keep Evolution on `127.0.0.1`. Do not publish port 8080 on `0.0.0.0` and do not open it in a firewall.
- Keep the image pinned to `evoapicloud/evolution-api:v2.3.7`. Releases from 2.4.0 require a license key, so `:latest` can break pairing.
- If something here fails, stop and report the exact error. Do not work around it by weakening a setting.

## 0. What you need

- A computer that stays on: macOS or Linux. Your laptop works too, but the tool only answers while it is awake.
- Node.js 20 or newer: `node --version`
- Docker with Compose: `docker compose version` (Docker Desktop, Colima or Docker Engine all work)
- Claude Code: `claude --version`. Install it from https://docs.claude.com/en/docs/claude-code if missing.
- Your phone with WhatsApp, to scan a QR code once

## 1. Get the code

```bash
git clone https://github.com/dangogit/whatsapp-claude-tag.git ~/whatsapp-claude-tag
cd ~/whatsapp-claude-tag
node --test --test-concurrency=2 test/*.test.mjs   # all tests should pass
```

## 2. Let Claude Code run in the background

The tool starts Claude Code with no terminal attached, so it needs a long-lived token.

1. **(you)** Run `claude setup-token` and finish the browser login. It prints a token that starts with `sk-ant-oat`.
2. Save it to a private file. The token may wrap onto two lines, so join them:

```bash
mkdir -p ~/.config/whatsapp-claude-tag && chmod 700 ~/.config/whatsapp-claude-tag
# paste the whole token between the quotes, then:
printf '%s' "PASTE_TOKEN_HERE" | tr -d '[:space:]' > ~/.config/whatsapp-claude-tag/claude-token
chmod 600 ~/.config/whatsapp-claude-tag/claude-token
```

An Anthropic API key (`ANTHROPIC_API_KEY`) works as well. Runs then bill to the API instead of your subscription.

## 3. Start Evolution API

Evolution API connects your number through WhatsApp Web and keeps the message history the tool reads. If the person does not want Docker, use the Baileys transport instead and follow [Without Evolution: Baileys](README.md#without-evolution-baileys) in place of steps 3 to 5 (it needs Node 22.13 or newer, and sees history only from pairing onward). Skip this step if you already run Evolution v2. In that case it must have Redis enabled and `DATABASE_SAVE_DATA_NEW_MESSAGE`, `DATABASE_SAVE_DATA_CONTACTS` and `DATABASE_SAVE_DATA_CHATS` set to `true`, and you need its URL and API key.

```bash
cd ~/whatsapp-claude-tag/deploy/evolution
cp .env.example .env
sed -i.bak "s/^AUTHENTICATION_API_KEY=.*/AUTHENTICATION_API_KEY=$(openssl rand -hex 24)/; s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env && rm .env.bak
chmod 600 .env
docker compose up -d
# wait until the API answers 200
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/)" = 200 ]; do sleep 3; done; echo ready
```

If port 8080 is taken, set `EVOLUTION_PORT` in `.env` and use that port everywhere below.

## 4. Connect your WhatsApp number

```bash
cd ~/whatsapp-claude-tag
node deploy/evolution/pair.mjs --instance personal
```

The script creates the instance, writes `deploy/evolution/qr-personal.png` and opens it.

**(you)** On your phone: WhatsApp > Settings > Linked devices > Link a device, then scan the QR. The script refreshes the code every 20 seconds and exits once it reads `personal is connected`. If it times out, run it again.

This uses one of WhatsApp's four linked-device slots. To connect a second number, such as a business number, repeat with another name: `--instance business`.

On a server with no screen, run it with `WCT_NO_OPEN=1` and copy the PNG to a machine where you can see it.

## 5. Configure the tool

```bash
cat > ~/.config/whatsapp-claude-tag/config.json <<EOF
{
  "evolution": {
    "url": "http://127.0.0.1:8080",
    "apiKeyEnv": "AUTHENTICATION_API_KEY",
    "envFile": "$HOME/whatsapp-claude-tag/deploy/evolution/.env"
  },
  "accounts": [
    { "name": "personal", "instance": "personal" }
  ],
  "triggers": ["claude"],
  "language": "en",
  "timezone": ""
}
EOF
chmod 600 ~/.config/whatsapp-claude-tag/config.json
```

- `envFile` points at the Evolution `.env`, so the API key lives in one place.
- Add `{ "name": "business", "instance": "business" }` to `accounts` if you paired a second number.
- `language: "he"` writes the tool's own notes in Hebrew. Claude always answers in the language of the request.
- An empty `timezone` uses the system one.
- The README lists every option.

Then the environment the service starts with:

```bash
cat > ~/.config/whatsapp-claude-tag/env.sh <<'EOF'
t="$HOME/.config/whatsapp-claude-tag/claude-token"
[ -s "$t" ] && export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$t")"
EOF
chmod 600 ~/.config/whatsapp-claude-tag/env.sh
```

## 6. Check everything

```bash
cd ~/whatsapp-claude-tag
sh -c '. ~/.config/whatsapp-claude-tag/env.sh; node src/cli.mjs check'
```

Every line must start with `ok`. The usual causes of a `FAIL`:

| Line | Cause | Fix |
|---|---|---|
| `instance ... is connecting` or `close` | Not paired, or the phone unlinked it | Step 4 again |
| `HTTP 401` | Wrong API key | `envFile` / `apiKeyEnv` in the config must match `.env` |
| `fetch failed` / `ECONNREFUSED` | Evolution is not running | `docker compose ps` in `deploy/evolution` |
| `claude auth: not logged in` | No token in the environment | Step 2, and run `check` through `env.sh` as shown |

## 7. Run it as a service

**macOS:**

```bash
cd ~/whatsapp-claude-tag
deploy/install-launchd.sh
```

Logs: `~/Library/Logs/whatsapp-claude-tag/out.log`.

**Linux (systemd user service):**

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/whatsapp-claude-tag.service <<EOF
[Unit]
Description=whatsapp-claude-tag
After=network-online.target

[Service]
ExecStart=/bin/sh $HOME/whatsapp-claude-tag/deploy/start.sh
Environment=PATH=$(dirname "$(command -v node)"):$(dirname "$(command -v claude)"):/usr/bin:/bin
Restart=always
RestartSec=15
TimeoutStopSec=330

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-claude-tag
loginctl enable-linger "$USER"   # keep it running after logout
journalctl --user -u whatsapp-claude-tag -f
```

The log should show one `"event":"watching"` line per account.

## 8. First test

**(you)** In WhatsApp, open the chat with yourself ("Message yourself") and send:

```
@claude what day is it today? one line
```

The answer arrives in the same chat within a few seconds. Then try it in a group:

```
@claude summarize today's messages here and send it to me privately
```

## Updating

```bash
cd ~/whatsapp-claude-tag && git pull --ff-only
launchctl kickstart -k gui/$(id -u)/com.whatsapp-claude-tag   # macOS
systemctl --user restart whatsapp-claude-tag                   # Linux
```

## Uninstalling

```bash
launchctl bootout gui/$(id -u)/com.whatsapp-claude-tag && rm ~/Library/LaunchAgents/com.whatsapp-claude-tag.plist   # macOS
systemctl --user disable --now whatsapp-claude-tag                                                                   # Linux
cd ~/whatsapp-claude-tag/deploy/evolution && docker compose down    # add -v to also delete the stored WhatsApp data
```

**(you)** Then remove the linked device on your phone: WhatsApp > Settings > Linked devices.
