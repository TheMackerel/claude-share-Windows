import darwin from "./darwin";
import linux from "./linux";
import win32 from "./win32";
import type { PlatformOps } from "./types";

const SUPPORTED = {
  darwin,
  linux,
  win32,
} satisfies Partial<Record<NodeJS.Platform, PlatformOps>>;

type SupportedPlatform = keyof typeof SUPPORTED;

let _cached: PlatformOps | null = null;

export function platform(): PlatformOps {
  if (_cached) return _cached;

  const p = process.platform as SupportedPlatform;
  if (!(p in SUPPORTED)) {
    process.stderr.write(
      `Unsupported platform: "${process.platform}". claude-share supports macOS (darwin), Linux and Windows.\n`,
    );
    process.exit(1);
  }

  _cached = SUPPORTED[p];
  return _cached;
}
