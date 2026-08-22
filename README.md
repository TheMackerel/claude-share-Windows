# claude-share

Securely share your Claude Code subscription with others.

One machine runs **claude-share** to expose its Claude credentials through a local proxy. Other machines run **claude-connect** to connect and use Claude Code as if they had their own subscription.

---

## How it works

```
Receiver machine                    Sharer machine
─────────────────                   ──────────────────────────────
claude (CLI)                        claude-share
  │                                   │
  │  HTTPS_PROXY=...                  ├─ MITM proxy (intercepts Anthropic API calls)
  └──────────────────────────────────>│    injects sharer's OAuth token
                                      │
                                      ├─ Hono API (pairing, health, CA cert)
                                      │
                                      └─ bore tunnel (public URL via bore.pub)
```

- The sharer's OAuth token is read from the platform credential store and injected per-request inside the MITM proxy — it is never written to disk or sent to the receiver.
- The receiver installs a temporary CA cert (valid only for the session) so the MITM can intercept Anthropic traffic. Non-Anthropic domains pass through as an opaque TCP tunnel — never inspected.
- Pairing uses a one-time code. Once paired, credentials are saved so reconnecting skips the pairing step.

---

## Install

```bash
npm install -g @0xpv/claude-share
```

This installs both `claude-share` and `claude-connect` binaries.

---

## Quickstart

### Sharer

```bash
claude-share
```

Requires [bore](https://github.com/ekzhang/bore) for internet sharing. If bore is not installed, claude-share downloads it for you on Linux and Windows, and uses `brew install bore-cli` on macOS — decline to share on LAN only.

The TUI shows connection URLs. Share the **Public** URL with receivers over the internet, or the **LAN** URL for local network.

**Keys:** `c` copy URL · `q` quit

### Receiver

```bash
# First time — paste the connect URL from the sharer's TUI
claude-connect --share <connect-url>

# Subsequent runs — pick from saved connections
claude-connect
```

The receiver configures Claude Code to route through the proxy and installs the session CA cert automatically. Everything is cleaned up on exit.

---

## One-time use (npx)

```bash
# Sharer
npx @0xpv/claude-share

# Receiver
npx -p @0xpv/claude-share claude-connect --share <connect-url>
```

---

## Requirements

- **macOS, Linux or Windows** on both machines
- **Node.js 18+** on both machines
- **bore** on the sharer machine for internet sharing — installed automatically on Linux and Windows, `brew install bore-cli` on macOS
- The sharer must be logged in to Claude Code (`claude login`)
- The receiver must have Claude Code installed

---

## Security model

- The sharer's OAuth token is read from wherever Claude Code keeps it — the macOS Keychain, or `~/.claude/.credentials.json` (`%USERPROFILE%\.claude\.credentials.json` on Windows) — and injected into requests in-memory. It is never transmitted to the receiver.
- Only these Anthropic endpoints are proxied: `POST /v1/messages`, `GET /v1/models`, `/api/hello`, and OAuth flows on `platform.anthropic.com` / `platform.claude.com`.
- File upload (`/v1/files`), fine-tuning, and assistants endpoints are blocked.
- All non-Anthropic HTTPS traffic passes through as an opaque TCP tunnel — the proxy never sees the contents.
- Sessions expire after the duration chosen at startup (6h / 24h / 1 week).

---

## Development

```bash
# Sharer
bun run dev:share

# Receiver
bun run dev:connect --share <connect-url>
```

Set `TUNNEL=0` to skip the bore tunnel during local development.

Build: `bun run build` — compiles both binaries into their `dist/` folders.
