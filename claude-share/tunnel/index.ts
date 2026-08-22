import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

import { IS_WINDOWS, which } from "@shared/exec";

const execFileAsync = promisify(execFile);

// Baked in at build time via --define; fall back to bore.pub in dev mode.
const BORE_SERVER = process.env.BORE_SERVER ?? "bore.pub";
const BORE_PASSWORD = process.env.BORE_PASSWORD ?? "";

// Where we install bore ourselves when it isn't already in PATH
const BORE_LOCAL_PATH = IS_WINDOWS
  ? path.join(os.homedir(), ".claude-share", "bin", "bore.exe")
  : path.join(os.homedir(), ".local", "bin", "bore");

export interface Tunnel {
  publicUrl: string | null;
  close(): void;
}

// Returns the bore binary path (from PATH or the known local install location),
// or null if bore is not found.
async function getBorePath(): Promise<string | null> {
  const inPath = await which("bore");
  if (inPath) return inPath;
  try {
    // X_OK is meaningless on Windows — an existing bore.exe is executable there
    await fs.promises.access(
      BORE_LOCAL_PATH,
      IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK,
    );
    return BORE_LOCAL_PATH;
  } catch {}
  return null;
}

export async function isBoreInstalled(): Promise<boolean> {
  return (await getBorePath()) !== null;
}

// Follow redirects and return the final response.
function httpsGet(url: string): Promise<import("http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const attempt = (target: string) => {
      https
        .get(target, { headers: { "User-Agent": "claude-share" } }, (res) => {
          if (
            (res.statusCode === 301 || res.statusCode === 302) &&
            res.headers.location
          ) {
            res.resume();
            attempt(res.headers.location);
          } else {
            resolve(res);
          }
        })
        .on("error", reject);
    };
    attempt(url);
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await httpsGet(url);
  return new Promise((resolve, reject) => {
    let data = "";
    res.on("data", (c: Buffer) => (data += c));
    res.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    res.on("error", reject);
  });
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await httpsGet(url);
  if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
    res.resume();
    throw new Error(`Download failed: HTTP ${res.statusCode}`);
  }
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on("finish", () => file.close(() => resolve()));
    file.on("error", reject);
  });
}

// Node process.arch → bore release target triple, per platform
const LINUX_ARCH_MAP: Record<string, string> = {
  x64: "x86_64-unknown-linux-musl",
  arm64: "aarch64-unknown-linux-musl",
  arm: "armv7-unknown-linux-musleabihf",
  ia32: "i686-unknown-linux-musl",
};

// bore ships no arm64 build for Windows; arm64 Windows runs x64 binaries under
// emulation, so point it at the x64 archive.
const WINDOWS_ARCH_MAP: Record<string, string> = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "x86_64-pc-windows-msvc",
  ia32: "i686-pc-windows-msvc",
};

// Windows 10 1803+ ships bsdtar, which reads zips; PowerShell is the fallback.
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  try {
    await execFileAsync("tar", ["-xf", zipPath, "-C", destDir]);
    return;
  } catch {}
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  await execFileAsync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destDir)} -Force`,
  ]);
}

// Downloads the pre-built bore binary from GitHub into BORE_LOCAL_PATH.
async function installBoreBinary(): Promise<void> {
  const archMap = IS_WINDOWS ? WINDOWS_ARCH_MAP : LINUX_ARCH_MAP;
  const triple = archMap[process.arch];
  if (!triple) {
    throw new Error(
      `No pre-built bore binary for arch "${process.arch}". ` +
        "Install bore manually: https://github.com/ekzhang/bore",
    );
  }

  const release = (await fetchJson(
    "https://api.github.com/repos/ekzhang/bore/releases/latest",
  )) as { tag_name: string };
  const tag = release.tag_name; // e.g. "v0.6.0"
  const ext = IS_WINDOWS ? "zip" : "tar.gz";
  const filename = `bore-${tag}-${triple}.${ext}`;
  const downloadUrl = `https://github.com/ekzhang/bore/releases/download/${tag}/${filename}`;

  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "bore-install-"),
  );
  const archivePath = path.join(tmpDir, filename);
  const binaryName = IS_WINDOWS ? "bore.exe" : "bore";

  try {
    await downloadToFile(downloadUrl, archivePath);

    // Archive contains a single bore binary at its root
    if (IS_WINDOWS) {
      await extractZip(archivePath, tmpDir);
    } else {
      await execFileAsync("tar", ["xzf", archivePath, "-C", tmpDir, binaryName]);
    }

    const installDir = path.dirname(BORE_LOCAL_PATH);
    await fs.promises.mkdir(installDir, { recursive: true });
    await fs.promises.copyFile(path.join(tmpDir, binaryName), BORE_LOCAL_PATH);
    if (!IS_WINDOWS) await fs.promises.chmod(BORE_LOCAL_PATH, 0o755);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

async function installViaCargo(spin: ReturnType<typeof p.spinner>): Promise<void> {
  spin.start("Running: cargo install bore-cli");
  try {
    await execFileAsync("cargo", ["install", "bore-cli"]);
    spin.stop("bore installed via cargo.");
  } catch (err) {
    spin.stop("Installation failed.");
    throw new Error(`Could not install bore: ${(err as Error).message}`);
  }
}

export async function installBore(): Promise<void> {
  const spin = p.spinner();

  if (process.platform === "linux" || process.platform === "win32") {
    spin.start("Downloading bore binary from GitHub...");
    try {
      await installBoreBinary();
      spin.stop(`bore installed to ${BORE_LOCAL_PATH}`);
      return;
    } catch (err) {
      spin.stop(`Binary download failed: ${(err as Error).message}. Falling back to cargo...`);
    }
    await installViaCargo(spin);
    return;
  }

  if (process.platform === "darwin") {
    if (!(await which("brew"))) {
      await installViaCargo(spin);
      return;
    }
    spin.start("Running: brew install bore-cli");
    try {
      await execFileAsync("brew", ["install", "bore-cli"]);
      spin.stop("bore installed.");
    } catch (err) {
      spin.stop("Installation failed.");
      throw new Error(`Could not install bore: ${(err as Error).message}`);
    }
    return;
  }

  throw new Error(
    "Unsupported platform — install bore manually: https://github.com/ekzhang/bore",
  );
}

export async function startTunnel(
  localPort: number,
  onDown?: () => void,
): Promise<Tunnel> {
  const boreBin = (await getBorePath()) ?? "bore";
  const args = ["local", String(localPort), "--to", BORE_SERVER];
  if (BORE_PASSWORD) args.push("--secret", BORE_PASSWORD);

  return new Promise((resolve, reject) => {
    const proc = spawn(boreBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let settled = false;
    let closing = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("bore timed out"));
      }
    }, 30_000);

    function onData(chunk: Buffer) {
      const text = chunk.toString();
      const match = text.match(/listening at \S+:(\d+)/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          publicUrl: `https://${BORE_SERVER}:${match[1]}`,
          close() {
            closing = true;
            proc.kill();
          },
        });
      }
    }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`bore exited with code ${code}`));
      } else if (!closing) {
        onDown?.();
      }
    });
  });
}
