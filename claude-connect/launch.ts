import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";

import { childEnv, commandExists, IS_WINDOWS, killTree, spawnCommand } from "@shared/exec";
import { platform } from "@shared/platforms";
import { apiFetch } from "./fetch";
import { logger } from "./logger";
import type { SharerAccount } from "./types";

// ── Onboarding ────────────────────────────────────────────────────────────────

export function ensureOnboarding() {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch {}

  if (config["hasCompletedOnboarding"] !== true) {
    p.log.info(
      "Onboarding not completed — marking it done so Claude launches directly.",
    );
    config["hasCompletedOnboarding"] = true;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
  }
}

// ── Credentials ───────────────────────────────────────────────────────────────

const PLACEHOLDER_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "1234",
    refreshToken: "",
    expiresAt: 4102444800000,
    scopes: [
      "user:file_upload",
      "user:inference",
      "user:mcp_servers",
      "user:profile",
      "user:sessions:claude_code",
    ],
    subscriptionType: "pro",
    rateLimitTier: "default_claude_ai",
  },
};

export async function ensureCredentials() {
  if (await platform().credentialsExist()) return;

  p.log.warn(
    "No Claude credentials found. Claude needs this to think you're logged in.",
  );
  const confirm = await p.confirm({
    message:
      "Create placeholder credentials so Claude launches without a login prompt?",
    initialValue: true,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.log.warn("Skipping credentials setup. Claude may redirect you to login.");
    return;
  }

  await platform().writeOAuthCredentials(PLACEHOLDER_CREDENTIALS);
  p.log.success("Placeholder credentials created.");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function checkClaudeInstalled(): Promise<boolean> {
  return commandExists("claude");
}

/** Contents of the CA bundle already in NODE_EXTRA_CA_CERTS, or "" if there is none. */
function readExistingCaBundle(): string {
  const existing = process.env["NODE_EXTRA_CA_CERTS"];
  if (!existing) return "";
  try {
    return fs.readFileSync(existing, "utf8");
  } catch (err) {
    logger.warn("Could not read the existing NODE_EXTRA_CA_CERTS bundle", {
      path: existing,
      err,
    });
    return "";
  }
}

export async function sessionPost(
  serverUrl: string,
  endpoint: string,
  body: Record<string, string>,
  caPem?: string,
  proxyAuth?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (proxyAuth) headers["Proxy-Authorization"] = proxyAuth;
  const r = await apiFetch(`${serverUrl}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeout: 5_000,
    ca: caPem,
  });
  return r.ok ? (r.json() as Promise<Record<string, unknown>>) : {};
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchClaude(
  proxyUrl: string,
  caPem: string,
  meta: {
    systemName: string;
    id: string;
    proxyUser: string;
    proxyPass: string;
  },
  claudeArgs: string[] = [],
  sharerAccount: SharerAccount | null = null,
) {
  if (!(await checkClaudeInstalled())) {
    p.log.error("Claude Code is not installed or not in PATH.");
    p.log.info("Install it with: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  ensureOnboarding();
  await ensureCredentials();

  if (sharerAccount) {
    p.log.info(
      `Account: ${sharerAccount.displayName} (${sharerAccount.emailAddress})`,
    );
  }

  // NODE_EXTRA_CA_CERTS names a single file, so replacing a bundle the machine
  // already relies on — an antivirus web shield, a corporate root — would drop
  // its trust for everything claude talks to. Carry both instead.
  const tmpCert = path.join(os.tmpdir(), `claude-share-ca-${Date.now()}.pem`);
  fs.writeFileSync(tmpCert, `${caPem.trimEnd()}\n${readExistingCaBundle()}`, {
    mode: 0o600,
  });

  const proxyAuth =
    "Basic " +
    Buffer.from(`${meta.proxyUser}:${meta.proxyPass}`).toString("base64");

  // Register this Claude session with the sharer
  let sessionId: string | null = null;
  try {
    const res = await sessionPost(
      proxyUrl,
      "/session/start",
      { machineId: meta.id },
      caPem,
      proxyAuth,
    );
    sessionId = (res["sessionId"] as string) ?? null;
    if (!sessionId)
      logger.warn("session/start returned no sessionId", {
        machineId: meta.id,
      });
  } catch (err) {
    logger.error("session/start failed", err);
  }

  // 30-second heartbeat so sharer sees lastActiveAt update
  const heartbeat = sessionId
    ? setInterval(() => {
        void sessionPost(
          proxyUrl,
          "/session/heartbeat",
          {
            machineId: meta.id,
            sessionId: sessionId!,
          },
          caPem,
          proxyAuth,
        ).catch(() => {});
      }, 30_000)
    : null;

  p.log.success("\x1b[32mLaunching Claude...\x1b[0m");

  p.outro("");

  const startTime = Date.now();

  // Proxy URL keeps https:// — the TLS terminator on the sharer routes CONNECT
  // requests to the MITM proxy after decryption, so the outer connection is
  // encrypted and proxy credentials are never sent in cleartext over the network.
  const parsedProxy = new URL(proxyUrl);
  parsedProxy.username = encodeURIComponent(meta.proxyUser);
  parsedProxy.password = encodeURIComponent(meta.proxyPass);
  const httpProxyUrl = parsedProxy.toString();

  // spawnCommand resolves the .cmd shim npm installs on Windows
  const child = await spawnCommand("claude", claudeArgs, {
    stdio: "inherit",
    env: childEnv({
      HTTPS_PROXY: httpProxyUrl,
      HTTP_PROXY: httpProxyUrl,
      NODE_EXTRA_CA_CERTS: tmpCert,
      SSL_CERT_FILE: tmpCert,
      CURL_CA_BUNDLE: tmpCert,
    }),
  });

  async function cleanupAndExit(code: number | null) {
    if (heartbeat) clearInterval(heartbeat);
    if (sessionId) {
      await sessionPost(
        proxyUrl,
        "/session/end",
        { machineId: meta.id, sessionId },
        caPem,
        proxyAuth,
      ).catch(() => {});
    }
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
    const duration = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    p.log.info(`Session ended. Duration: ${mins}m ${secs}s`);
    process.exit(code ?? 0);
  }

  child.on("exit", (code) => {
    void cleanupAndExit(code);
  });

  child.on("error", (err) => {
    logger.error("Failed to launch claude process", err);
    p.log.error(`Failed to launch claude: ${err.message}`);
    p.log.warn(
      "Is 'claude' installed? Run: npm install -g @anthropic-ai/claude-code",
    );
    if (heartbeat) clearInterval(heartbeat);
    if (sessionId) {
      void sessionPost(
        proxyUrl,
        "/session/end",
        { machineId: meta.id, sessionId },
        caPem,
        proxyAuth,
      ).catch(() => {});
    }
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
    process.exit(1);
  });

  // Windows delivers Ctrl+C to every process attached to the console, so claude
  // has already been interrupted and gets to shut down on its own terms; only a
  // second interrupt kills the tree (claude runs as a grandchild of cmd.exe there).
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (!IS_WINDOWS) {
      child.kill("SIGINT");
      return;
    }
    if (++interrupts > 1) killTree(child, "SIGKILL");
  });
  process.on("SIGTERM", () => killTree(child, "SIGTERM"));
}
