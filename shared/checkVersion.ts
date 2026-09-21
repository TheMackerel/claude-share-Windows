import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";

import pkg from "../package.json";

// This fork is installed from source, never from npm: the package published under
// pkg.name is upstream's, and it has no Windows support — auto-upgrading to it would
// silently replace a working install with one that exits on startup. So the update
// check reads this repo's GitHub releases and only ever prints what to run; it
// installs nothing.
const CURRENT_VERSION: string = pkg.version;
const REPO = "TheMackerel/claude-share-Windows";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const UPDATE_COMMAND = "git pull && bun run build";
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

/**
 * Latest release tag of the fork, or null when there is nothing to compare:
 * no releases published yet (404), offline, rate-limited, malformed response.
 * Never throws — every caller treats null as "no update".
 */
async function fetchLatestRelease(timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `claude-share/${CURRENT_VERSION}`,
      },
    });
    if (!res.ok) return null;
    const json = JSON.parse((await res.text()).trim()) as Record<string, unknown>;
    const tag = json["tag_name"];
    return typeof tag === "string" && tag.trim() ? tag.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function scheduleVersionCheck(): void {
  void (async () => {
    try {
      const latest = await fetchLatestRelease(5_000);
      if (!latest) return;

      // Set or clear the flag so the next startup knows what to do
      patchConfig({ isUpgradeAvailable: isNewer(latest, CURRENT_VERSION) });
    } catch {}
  })();
}

// ── Upgrade ───────────────────────────────────────────────────────────────────

/**
 * Tell the user how to update. Deliberately runs nothing: the install is a git
 * clone linked with `npm install -g .`, so updating means pulling and rebuilding in
 * that folder — a package manager can only get it wrong here.
 */
function announceUpdate(latest: string): void {
  // Clear the flag so the notice shows once per release; the background check
  // re-sets it if this build is still behind.
  patchConfig({ isUpgradeAvailable: false });
  p.log.warn(`claude-share ${latest} is available (this build: ${CURRENT_VERSION}).`);
  p.log.info(`Update from your clone with: ${UPDATE_COMMAND}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function forceUpgrade(): Promise<void> {
  p.intro("upgrade");

  const spin = p.spinner();
  spin.start("Checking latest release…");

  const latest = await fetchLatestRelease(10_000);

  if (!latest) {
    spin.stop(`No release found for ${REPO} (or it could not be reached).`);
    p.log.info(`Update from your clone with: ${UPDATE_COMMAND}`);
    p.outro("");
    process.exit(0);
  }

  if (!isNewer(latest, CURRENT_VERSION)) {
    spin.stop(`Already up to date (${CURRENT_VERSION}).`);
    p.outro("Nothing to upgrade.");
    process.exit(0);
  }

  spin.stop(`New release available: ${latest} (this build: ${CURRENT_VERSION})`);
  p.log.info(`Update from your clone with: ${UPDATE_COMMAND}`);
  p.outro("");
  process.exit(0);
}

/**
 * Call once at CLI startup.
 *
 * Phase 1 (sync): reads config — if isUpgradeAvailable is true, prints how to update.
 * Phase 2 (async): fires a background release fetch; writes the flag for next run.
 * All errors are swallowed — this never crashes the caller, and it never installs.
 */
export async function checkForUpdate(): Promise<void> {
  try {
    if (readConfig()["isUpgradeAvailable"] === true) {
      const latest = await fetchLatestRelease(3_000);
      if (latest && isNewer(latest, CURRENT_VERSION)) announceUpdate(latest);
      else patchConfig({ isUpgradeAvailable: false });
    }
  } catch {}

  scheduleVersionCheck();
}
