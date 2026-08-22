import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CredentialPayload, OAuthCredentials } from "./types";

// Claude Code keeps its OAuth credentials in a plain JSON file on every platform
// except macOS (which uses the Keychain). CLAUDE_CONFIG_DIR relocates the whole
// config directory, so honour it here too.
function configDir(): string {
  const override = process.env["CLAUDE_CONFIG_DIR"];
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".claude");
}

export function credentialsPath(): string {
  return path.join(configDir(), ".credentials.json");
}

export async function readOAuthCredentials(): Promise<OAuthCredentials> {
  const raw = await fs.promises.readFile(credentialsPath(), "utf8");
  const payload: CredentialPayload = JSON.parse(raw);
  return payload.claudeAiOauth;
}

export async function credentialsExist(): Promise<boolean> {
  return fs.existsSync(credentialsPath());
}

export async function writeOAuthCredentials(payload: CredentialPayload): Promise<void> {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // mode is a no-op on Windows, where the file inherits the ACL of the user profile
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
}
