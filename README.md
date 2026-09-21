# claude-share-Windows

Securely share your Claude Code subscription with others — **Windows port** of
[prathamVaidya/claude-share](https://github.com/prathamVaidya/claude-share), which supports macOS and Linux only.
Runs on Windows, macOS and Linux.

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

- The sharer's OAuth token is read from the platform credential store and injected per-request — it is never written to disk or sent to the receiver.
- By default the receiver reaches the API through the sharer's relay endpoint: `claude` talks to a loopback address on the receiver's own machine, which forwards over TLS to the sharer. No certificate has to be installed or trusted anywhere.
- When the sharer runs an older version, the receiver falls back to the original proxy mode: a temporary session CA cert lets the MITM intercept Anthropic traffic, while non-Anthropic domains pass through as an opaque TCP tunnel, never inspected. On Windows this mode does not work with Claude Code's native build, which ignores `NODE_EXTRA_CA_CERTS` — update both sides to use the relay instead.
- Pairing uses a one-time code. Once paired, credentials are saved so reconnecting skips the pairing step.

---

## Install

This fork is **not published to npm**. `npm install -g @0xpv/claude-share` installs the upstream
package instead, which exits with `Unsupported platform: "win32"`. Build from source:

### Windows (PowerShell)

```powershell
git clone https://github.com/TheMackerel/claude-share-Windows.git
cd claude-share-Windows
npm install -g bun      # skip if bun is already installed
bun install
bun run build
npm install -g .
```

### macOS / Linux

```bash
git clone https://github.com/TheMackerel/claude-share-Windows.git
cd claude-share-Windows
npm install -g bun      # skip if bun is already installed
bun install
bun run build
npm install -g .
```

That puts both `claude-share` and `claude-connect` on your PATH. Verify:

```bash
claude-share --version
claude-connect --version
```

Both should print `1.3.2`.

### Things to know

- `npm install -g .` **links** the commands to this folder — don't move or delete the clone, and stay
  on `main`. After `git pull`, `bun run build` is enough; there's no need to re-run
  `npm install -g .`.
- Windows: npm also creates `.ps1` shims. If PowerShell answers *"running scripts is disabled on this
  system"*, either call `claude-share.cmd` / `claude-connect.cmd`, or allow local scripts once with
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- Windows: no administrator rights are needed, and nothing is ever added to the Windows certificate
  store. The relay exists so the receiver needs no certificate trust at all; only the fallback proxy
  mode hands the session CA to `claude` through `NODE_EXTRA_CA_CERTS`.
- Windows, sharer only: Defender may prompt to unblock the listening port, and SmartScreen may flag the
  automatic `bore` download from GitHub.

---

## Updating

```bash
git pull
bun install
bun run build
```

Use `git pull`, not `git fetch` or `git checkout`: `fetch` only moves `origin/main`, and checking out
a branch you are already on does nothing, so either one leaves you rebuilding the same old code.

**If you share, restart `claude-share` afterwards.** A running process keeps the build it started
with, so a rebuild alone changes nothing for the people connecting to you.

**Lost the clone?** The global commands link to it, so its path can be recovered.

Windows (PowerShell):

```powershell
$pkg = Join-Path (npm root -g) "@0xpv\claude-share"
(Get-Item $pkg).Target
```

macOS / Linux:

```bash
readlink -f "$(npm root -g)/@0xpv/claude-share"
```

If that turns up nothing, clone again somewhere else and redo the install steps — the final
`npm install -g .` repoints the link, and the old folder stops mattering.

To confirm an update landed, `git log --oneline -1` should name the commit you expected. Whoever
shares can also be checked from the receiving side: `curl -k https://bore.pub:<port>/health` reports
`"relay":true` on a sharer running current code.

Both commands check this repo's GitHub releases at startup and print that command when a newer release
exists. They never install anything themselves and never look at npm — upstream's npm package has no
Windows support, so auto-upgrading to it would break the install. `claude-share --upgrade` (or
`claude-connect --upgrade`) runs the same check on demand.

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

## Run without installing globally

Skip `npm install -g .` and run straight from the clone:

```bash
# Sharer
bun claude-share/index.ts

# Receiver
bun claude-connect/index.ts --share <connect-url>
```

`npx @0xpv/claude-share` is **not** an option for this fork — npx fetches the upstream package, which
has no Windows support.

---

## Requirements

- **macOS, Linux or Windows** on both machines
- **Node.js 18+** and **npm** on both machines
- **git** and **bun** to build from source (`npm install -g bun`)
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
