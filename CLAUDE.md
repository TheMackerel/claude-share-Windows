# claude-share

Single npm package (`@0xpv/claude-share`) exposing two binaries: `claude-share` (sharer) and `claude-connect` (receiver). Source lives in `claude-share/src/` and `claude-connect/src/` respectively; both compile into their own `dist/` via the root `package.json`.

## Dev commands

```bash
bun run dev                                      # claude-share (TUNNEL=0 to skip bore)
bun run dev:connect --share=<url>                # claude-connect
# or directly:
bun claude-share/src/index.ts
bun claude-connect/src/index.ts --share=<url>
```

Build: `bun run build` (compiles both via bun build). Lint: `bun run lint`.

## Architecture

**Single public port** (default 2586): `port/detector.ts` sniffs first bytes — `CONNECT` goes to MITM proxy, TLS ClientHello (`0x16`) is terminated and piped to the Hono API on `PORT+1`, plain HTTP is piped to the Hono API on `PORT+1` (localhost-only). Bore tunnels PORT.

**MITM proxy** (`proxy/mitm.ts`): intercepts TLS only for `INTERCEPT_DOMAINS` (`api.anthropic.com`, `platform.anthropic.com`, `platform.claude.com`, `mcp-proxy.anthropic.com`). All other CONNECT requests are transparent TCP-piped — never touch the cert or plaintext.

**Token injection**: sharer's OAuth token is read at startup through `shared/platforms/` — macOS Keychain on darwin, `~/.claude/.credentials.json` on Linux and Windows (`CLAUDE_CONFIG_DIR` relocates it) — and injected per-request inside the MITM. Never written to disk, never sent to receiver.

**Relay — the path receivers take by default** (`server/index.ts` `/relay/*` + `claude-connect/relay.ts`): the sharer forwards the API call itself and the receiver points `ANTHROPIC_BASE_URL` at a loopback HTTP forwarder, so the receiver's `claude` never has to trust the session CA. It has to work this way because Claude Code's native Windows build ignores `NODE_EXTRA_CA_CERTS` (anthropics/claude-code#71581), which the proxy path depends on. `/health` advertises `relay: true`; a receiver that doesn't see it falls back to `HTTPS_PROXY` + the MITM, so old and new versions still pair with each other. Both paths enforce the same allowlist from `proxy/policy.ts` — keep it that way, it is the only thing bounding what the sharer's token can do. Responses stream through (`Readable.toWeb`), which SSE depends on: never buffer a relayed body.

**Platform support**: darwin, linux, win32. Anything OS-specific belongs in one of two places — `shared/platforms/` (credential store, machine name; `resolver.ts` picks the implementation and exits on anything else) or `shared/exec.ts` (PATH lookup, spawning, process trees). Don't reach for `execFile("which"|"lsof"|"kill", …)` directly; on Windows those don't exist and npm-installed CLIs (`claude`, `npm`, …) are `.cmd` shims that CreateProcess refuses to run — `spawnCommand`/`execCommand` wrap them in cmd.exe with the argument escaping that requires.

**Pairing**: connect URL format is `http://<host>/connect/<pairingCode>`. The pairingCode is `base58(32-byte session key)` — it's also the private decryption key. Only the first 5 chars are sent over HTTP for session lookup; the receiver decrypts the response blob locally using the full key from the URL.

**Session key lifecycle**: `session.key` (32 bytes) → `session.pairingCode` (base58). Pressing `n` in TUI calls `regeneratePairingCode()` which zeroes nothing but replaces key+code and clears `pairingAttempts`. `destroySession()` zeroes the key.

## Security constraints — do not break

- Never log or transmit the full pairingCode over HTTP (it's the private key)
- Only send `pairingCode.slice(0, 5)` in the `/pair` POST body
- `INTERCEPT_DOMAINS` must stay minimal — non-Anthropic traffic must bypass the MITM
- Blocked on `api.anthropic.com`: `/v1/files`, `/v1/fine_tuning`, `/v1/assistants`
- Rate limit: 5 attempts per known IP, 20 for `"unknown"` (bore doesn't forward real IPs)
- `shared/checkVersion.ts` must never install anything. This fork ships from source, and `pkg.name`
  resolves to upstream's npm package, which has no Windows support — an auto-upgrade would replace a
  working install with one that exits on startup. Check this repo's GitHub releases, print
  `git pull && bun run build`, install nothing.

## Receiver saved state

`~/.claude-share/connections/<machineId>.json` — pruned on startup if `sharedUntil` is past.  
`~/.claude-share/config.json` — device name.

(`%USERPROFILE%\.claude-share\` on Windows — `os.homedir()` throughout, so no separate path handling.)

## Known quirks

- `ensureBore()` must run **before** any `p.intro()`/`p.select()` calls. clack's `p.confirm()` tears down stdin in a way ink can't recover from if it runs after other prompts.
- `--share <url>` and `--share=<url>` are both supported in the receiver.
- bore doesn't set `x-forwarded-for`, so all bore requests arrive as `ip = "unknown"`.
- On Windows the console delivers Ctrl+C to every attached process, so `claude` is already interrupted by the time the receiver's SIGINT handler runs — it kills the process tree only on a second interrupt.
- `netstat -ano` is parsed without `-p tcp`: a dual-stack listener is reported under TCPv6, which the filter drops. Listening rows are identified by foreign port `0`, since the state column is localized.
