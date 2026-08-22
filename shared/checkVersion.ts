import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";

import { commandExists, execCommand } from "./exec";
import pkg from "../package.json";

const CURRENT_VERSION: string = pkg.version;
const PACKAGE_NAME: string = pkg.name;
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const CONFIG_FILE = path.join(os.homedir(), ".claude-share", "config.json");

// ── Config helpers ────────────────────────────────────────────────────────────

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function patchConfig(patch: Record<string, unknown>): void {
  try {
    const dir = path.dirname(CONFIG_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ ...readConfig(), ...patch }, null, 2),
      { mode: 0o600 },
    );
  } catch {}
}

// ── Semver ────────────────────────────────────────────────────────────────────

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[]; // dot-separated pre-release identifiers, empty = release
}

function parseSemver(v: string): SemVer {
  const clean = v.replace(/^v/, "");
  const dashIdx = clean.indexOf("-");
  const main = dashIdx === -1 ? clean : clean.slice(0, dashIdx);
  const preRaw = dashIdx === -1 ? "" : clean.slice(dashIdx + 1);
  const [majorStr = "0", minorStr = "0", patchStr = "0"] = main.split(".");
  return {
    major: parseInt(majorStr, 10) || 0,
    minor: parseInt(minorStr, 10) || 0,
    patch: parseInt(patchStr, 10) || 0,
    pre: preRaw ? preRaw.split(".") : [],
  };
}

// Returns >0 if a > b, <0 if a < b, 0 if equal — per semver §11
function comparePreRelease(a: string[], b: string[]): number {
  // Release (no pre-release) beats any pre-release version
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1; // fewer identifiers = lower precedence
    if (i >= b.length) return 1;
    const ai = a[i]!;
    const bi = b[i]!;
    const aIsNum = /^\d+$/.test(ai);
    const bIsNum = /^\d+$/.test(bi);
    if (aIsNum && bIsNum) {
      const diff = parseInt(ai, 10) - parseInt(bi, 10);
      if (diff !== 0) return diff;
    } else if (aIsNum) {
      return -1; // numeric < alphanumeric (§11.4.1)
    } else if (bIsNum) {
      return 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  return 0;
}

function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  if (l.patch !== c.patch) return l.patch > c.patch;
  return comparePreRelease(l.pre, c.pre) > 0;
}

// ── Background version fetch ──────────────────────────────────────────────────

function latestPublishedVersion(json: Record<string, unknown>): string | null {
  // Prefer dist-tags.latest — npm's authoritative "current" tag.
  const distTags = json["dist-tags"] as Record<string, string> | undefined;
  if (distTags?.["latest"]) return distTags["latest"];

  // Fall back: highest stable version, then highest pre-release.
  const versions = (json["versions"] ?? {}) as Record<string, unknown>;
  const all = Object.keys(versions);
  if (all.length === 0) return null;
  const stable = all.filter((v) => !v.includes("-"));
  const pool = stable.length > 0 ? stable : all;
  return pool.reduce((best, v) => (isNewer(v, best) ? v : best), pool[0]!);
}

function scheduleVersionCheck(): void {
  void (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      let text: string;
      try {
        const res = await fetch(REGISTRY_URL, {
          signal: controller.signal,
          headers: { Accept: "application/vnd.npm.install-v1+json" },
        });
        clearTimeout(timer);
        if (!res.ok) return;
        text = (await res.text()).trim();
      } catch {
        clearTimeout(timer);
        return;
      }

      const json = JSON.parse(text) as Record<string, unknown>;
      const latest = latestPublishedVersion(json);
      if (!latest) return;

      // Set or clear the flag so the next startup knows what to do
      patchConfig({ isUpgradeAvailable: isNewer(latest, CURRENT_VERSION) });
    } catch {}
  })();
}

// ── Upgrade ───────────────────────────────────────────────────────────────────

async function detectPackageManager(): Promise<string | null> {
  const candidates = ["bun", "pnpm", "yarn", "npm"];
  const execPath = process.env["npm_execpath"] ?? "";
  if (execPath.includes("bun")) candidates.unshift("bun");
  else if (execPath.includes("pnpm")) candidates.unshift("pnpm");
  else if (execPath.includes("yarn")) candidates.unshift("yarn");

  for (const pm of new Set(candidates)) {
    if (await commandExists(pm)) return pm;
  }
  return null;
}

function installArgs(pm: string): [string, string[]] {
  switch (pm) {
    case "bun": return ["bun", ["install", "-g", `${PACKAGE_NAME}@latest`]];
    case "pnpm": return ["pnpm", ["add", "-g", `${PACKAGE_NAME}@latest`]];
    case "yarn": return ["yarn", ["global", "add", `${PACKAGE_NAME}@latest`]];
    default: return ["npm", ["install", "-g", `${PACKAGE_NAME}@latest`]];
  }
}

async function attemptUpgrade(): Promise<void> {
  // Clear flag before attempting so a crash/failure doesn't retry every run;
  // the background check will re-set it next time if still outdated.
  patchConfig({ isUpgradeAvailable: false });

  const pm = await detectPackageManager();
  if (!pm) {
    p.log.info(`Run: npm install -g ${PACKAGE_NAME}@latest`);
    return;
  }

  const [cmd, args] = installArgs(pm);
  const spin = p.spinner();
  spin.start(`Upgrading via ${pm}…`);
  try {
    // execCommand runs the .cmd shims npm/pnpm/yarn install on Windows
    await execCommand(cmd, args, { timeout: 90_000 });
    spin.stop("Upgraded successfully. Please restart the CLI.");
    process.exit(0);
  } catch (err) {
    spin.stop(`Auto-upgrade failed: ${(err as Error).message}`);
    p.log.info(`Run manually: ${cmd} ${args.join(" ")}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function forceUpgrade(): Promise<void> {
  p.intro("upgrade");

  const spin = p.spinner();
  spin.start("Checking latest version…");

  let latest: string | null = null;
  let fetchError: string | null = null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = JSON.parse((await res.text()).trim()) as Record<string, unknown>;
      latest = latestPublishedVersion(json);
      if (!latest) fetchError = "No versions found in registry.";
    } else {
      fetchError = `Registry returned HTTP ${res.status}`;
    }
  } catch (err) {
    clearTimeout(timer);
    fetchError = (err as Error).message ?? String(err);
  }

  if (!latest) {
    spin.stop(`Could not check for updates: ${fetchError}`);
    p.log.info(`Run manually: npm install -g ${PACKAGE_NAME}@latest`);
    process.exit(1);
  }

  if (!isNewer(latest, CURRENT_VERSION)) {
    spin.stop(`Already on the latest version (${CURRENT_VERSION}).`);
    p.outro("Nothing to upgrade.");
    process.exit(0);
  }

  spin.stop(`New version available: ${latest} (current: ${CURRENT_VERSION})`);
  await attemptUpgrade();
}

/**
 * Call once at CLI startup.
 *
 * Phase 1 (sync): reads config — if isUpgradeAvailable is true, upgrades now.
 * Phase 2 (async): fires a background version fetch; writes the flag for next run.
 * All errors are swallowed — this must never crash the caller.
 */
export async function checkForUpdate(): Promise<void> {
  try {
    if (readConfig()["isUpgradeAvailable"] === true) {
      p.log.warn(`A newer version of ${PACKAGE_NAME} is available. Upgrading…`);
      await attemptUpgrade();
    }
  } catch {}

  scheduleVersionCheck();
}
