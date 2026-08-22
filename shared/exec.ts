import { execFile, spawn } from "node:child_process";
import type { ChildProcess, ExecFileOptions, SpawnOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const IS_WINDOWS = process.platform === "win32";

// ── Lookup ────────────────────────────────────────────────────────────────────

/** Absolute path of an executable in PATH, or null. `which` on POSIX, `where` on Windows. */
export async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(IS_WINDOWS ? "where" : "which", [command]);
    // `where` can return several matches (claude.cmd, claude.ps1, …) — take the first
    const first = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

export async function commandExists(command: string): Promise<boolean> {
  return (await which(command)) !== null;
}

// ── Windows shim handling ─────────────────────────────────────────────────────

// npm-installed CLIs (claude, npm, pnpm, yarn…) are .cmd/.bat shims on Windows.
// CreateProcess cannot execute those directly, so they have to run through
// cmd.exe. Each argument is quoted for CommandLineToArgvW first, then its
// cmd.exe metacharacters are escaped twice — once for cmd.exe itself and once
// more because a batch shim re-parses the line when it forwards its arguments.
const SHIM_RE = /\.(cmd|bat)$/i;
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(META_CHARS, "^$1");
}

// Quoting rules of CommandLineToArgvW: backslashes are literal unless they
// precede a double quote, in which case they must be doubled and the quote
// escaped. Trailing backslashes precede the closing quote, so they double too.
function quoteArgument(arg: string): string {
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
    } else if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += "\\".repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return out + "\\".repeat(backslashes * 2) + '"';
}

function escapeCmdArgument(arg: string): string {
  const quoted = quoteArgument(arg);
  return quoted.replace(META_CHARS, "^$1").replace(META_CHARS, "^$1");
}

export interface ResolvedCommand {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * Turns a bare command name into something spawnable directly on this platform.
 * On POSIX it is a no-op; on Windows it resolves the command through PATH and
 * wraps batch shims in a cmd.exe invocation.
 */
export async function resolveCommand(
  command: string,
  args: string[] = [],
): Promise<ResolvedCommand> {
  if (!IS_WINDOWS) {
    return { file: command, args, windowsVerbatimArguments: false };
  }

  const resolved = (await which(command)) ?? command;
  if (!SHIM_RE.test(resolved)) {
    return { file: resolved, args, windowsVerbatimArguments: false };
  }

  const line = [escapeCmdCommand(resolved), ...args.map((a) => escapeCmdArgument(a))].join(" ");

  return {
    file: process.env["ComSpec"] || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

// ── Spawning ──────────────────────────────────────────────────────────────────

/** spawn() that also works for Windows batch shims. */
export async function spawnCommand(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): Promise<ChildProcess> {
  const resolved = await resolveCommand(command, args);
  return spawn(resolved.file, resolved.args, {
    ...options,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
  });
}

/** execFile() that also works for Windows batch shims. */
export async function execCommand(
  command: string,
  args: string[] = [],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const resolved = await resolveCommand(command, args);
  const { stdout, stderr } = await execFileAsync(resolved.file, resolved.args, {
    ...options,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/**
 * Terminates a child and everything it started. On Windows a shimmed command
 * runs as a grandchild of cmd.exe, so killing the child alone leaves it behind.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (IS_WINDOWS && child.pid) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
    return;
  }
  child.kill(signal);
}
