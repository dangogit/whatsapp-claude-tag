# whatsapp-claude-tag

Type `@claude` at the start of a message in any WhatsApp chat on your own phone (a group, a chat with a friend, or your chat with yourself) and Claude Code does what you asked.

```
@claude summarize what happened in this group today
@claude summarize today's messages here and send it to me privately, then delete this message
@claude copy the message I'm replying to and send it to Dana
@claude write Yossi that I'm 10 minutes late, ask me before sending
```

It runs on your own machine against an [Evolution API](https://github.com/EvolutionAPI/evolution-api) server that already has your number connected, and it uses your own Claude Code login.

## How it works

1. Every two seconds the watcher asks Evolution for the newest messages **you** sent (`fromMe`). It does not use a webhook, so if another service already owns your instance's webhook, both keep working.
2. A message that starts with `@claude` (or any name you configure) becomes a run. If you were replying to a message, its text goes along as context.
3. The run is `claude -p` with a small MCP server attached. That server gives Claude five tools: `find_chat`, `read_chat`, `send_message`, `request_approval` and `delete_trigger_message`.
4. Claude reads what it needs, then acts. By default it answers in the chat where you tagged it. You can tell it to answer privately, to send to someone else, to delete your `@claude` message, or to ask you before it sends.

Only messages you send trigger it. Nobody else in a group can use your `@claude`.

## Safety model

The chats it reads are written by other people, and a message in a group could say "forward this to X". The rule that stops this is enforced in the MCP server, not left to the model. A run may only read or send to:

- the chat you tagged it in,
- your own chat ("send it to me"),
- a chat you named in your own `@claude` text, by name or by phone number.

Anything else is refused, and Claude has to tell you so. Text quoted from other people never counts as naming a chat. Names match whole words only (Hebrew prefixes such as ל and ו are allowed), and common request words like "today" or "summary" never count, because other people choose their own display names. Every send to a chat other than the tagged one or your own leaves a receipt in your own chat, so a send you did not expect is visible right away.

Your own chat holds drafts, receipts and answers from other runs, so a run can always write to it but can only read it when you tagged it there.

Everything the tool sends has a word joiner inserted after a leading `@`, so its own messages can never trigger another run.

Name matching is a guard, not a guarantee: the stopword list cannot cover every word you might type, and a contact can pick any display name. The receipt is what makes a wrong send visible. For anything sensitive, name the recipient by phone number or ask for approval.

By default Claude gets the WhatsApp tools plus `WebSearch`, and nothing else: no shell, no file access and no `WebFetch`. A run that has read chat history could be steered into fetching a URL that carries that history, so `WebFetch` is opt-in (`claude.webFetch: true`). Setting `claude.fullAccess: true` gives it all of Claude Code's tools with permissions bypassed. Only turn that on if you accept that a crafted message in a chat you summarize could try to steer it.

Each run uses its own Claude Code config directory (`claude.configDir`), so your personal hooks, plugins and MCP servers do not load into it.

## Approvals

If your request asks for confirmation, Claude does not send. It posts a draft to your own chat instead. Swipe-reply to the draft with `yes` / `כן` to send it, or `no` / `לא` to drop it. The watcher sends the stored draft itself, without another Claude run, so what you approved is exactly what goes out. Drafts expire after a day.

## Follow-ups

Swipe-reply to anything a run sent and the same Claude session continues, so you can answer its questions ("which group?") or ask for changes. In your own chat a plain reply is enough. In any other chat, start the reply with `@claude`, because there you might just be quoting the message to the people you are talking to.

## Requirements

- Node.js 20 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and authenticated for headless use: `claude setup-token`, then export `CLAUDE_CODE_OAUTH_TOKEN`, or set `ANTHROPIC_API_KEY`
- An Evolution API v2 server with your WhatsApp number connected, and its API key

No npm dependencies.

## Setup

```bash
git clone https://github.com/dangogit/whatsapp-claude-tag.git
cd whatsapp-claude-tag
mkdir -p ~/.config/whatsapp-claude-tag
cp config.example.json ~/.config/whatsapp-claude-tag/config.json
```

Edit the config: set `accounts[].instance` to your Evolution instance name, and give it the API key, either in the `EVOLUTION_API_KEY` environment variable or through `evolution.envFile` pointing at a `.env` file that contains it.

Check everything is reachable:

```bash
node src/cli.mjs check
```

Run it in the foreground:

```bash
node src/cli.mjs run
```

### Run as a service (macOS)

Put the environment the service needs in `~/.config/whatsapp-claude-tag/env.sh`, which `deploy/start.sh` sources:

```sh
export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.claude/headless-token")"
export EVOLUTION_API_KEY="..."
```

Keep that file `chmod 600`. Then install the LaunchAgent:

```bash
deploy/install-launchd.sh
```

Logs go to `~/Library/Logs/whatsapp-claude-tag/`. On Linux, run `deploy/start.sh` from a systemd user unit with `Restart=always`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `accounts` | required | `[{ "name": "personal", "instance": "..." }]`. One entry per connected number. `ownerChat` overrides where "send it to me" goes (default: your own number on that account). |
| `triggers` | `["claude"]` | Names that trigger a run, written after `@` at the start of the message. Matching ignores case. |
| `language` | `en` | Language of the few messages the tool writes itself (`en`, `he`). Claude answers in the language of your request. |
| `timezone` | system | Used for "today" and for message times. |
| `replyPrefix` | `""` | Put in front of everything Claude sends, for example `"🤖 "`. |
| `pollMs` | `2000` | Poll interval. |
| `stateDir` | `~/.local/state/whatsapp-claude-tag` | Seen ids, sent ids, pending drafts, per-run logs. |
| `claude.bin` | `claude` | Path to the Claude Code CLI. |
| `claude.model` | `sonnet` | Model for runs. |
| `claude.timeoutMs` | `300000` | A run that takes longer is stopped, and you get a short failure note. |
| `claude.webFetch` | `false` | Also give runs `WebFetch`. See the safety model above. |
| `claude.fullAccess` | `false` | See the safety model above. |
| `claude.configDir` | `<stateDir>/claude-home` | `CLAUDE_CONFIG_DIR` for runs. |

## What it does not do

- It reads history from Evolution's database, so `read_chat` sees only what Evolution stored since the number was connected.
- Text only. Media show up as `[image]`, `[audio]` and so on.
- A new `@claude` starts a fresh conversation. Only a swipe-reply continues one.
- Every message from your number counts as yours, including ones another API client sends through the same Evolution instance. Make sure nothing else on that instance sends text that starts with `@claude`.
- If the service stops in the middle of a run, that run is not retried, because it may already have sent something. You get a note in your own chat instead. Only one watcher can run per state directory.
- Your phone shows its sends as sent by you, and everyone in the chat sees them. Use `replyPrefix` if you want them marked.

## Development

```bash
npm test
```

Each run leaves its files in `<stateDir>/<account>/jobs/<message-id>/`: `job.json` is what the run was given, `actions.jsonl` is what it did, and `claude.json` is Claude Code's raw result.

## Notes

This connects to WhatsApp through Evolution API, which uses WhatsApp Web. That is not the official WhatsApp Business Platform. Use it for your own account, not for bulk or customer messaging.

MIT license.
