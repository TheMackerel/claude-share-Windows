#!/usr/bin/env bun
// Build script that bakes BORE_SERVER and BORE_PASSWORD into the claude-share bundle at compile time.
// Override defaults by setting the env vars before running: BORE_SERVER=my.server bun run build

const boreServer = process.env.BORE_SERVER || "bore.pub";
const borePassword = process.env.BORE_PASSWORD || "";

function build(entry: string, outfile: string, extraArgs: string[] = []) {
  // `bun` in PATH can be an npm .cmd shim (Windows); Bun.spawnSync refuses to pass
  // arguments containing cmd.exe special characters to it. process.execPath is the
  // bun binary running this script.
  const result = Bun.spawnSync(
    [
      process.execPath, "build", entry,
      "--outfile", outfile,
      "--target", "node",
      "--production",
      ...extraArgs,
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

build("claude-share/index.ts", "dist/claude-share/index.js", [
  "--define", `process.env.NODE_ENV="production"`,
  "--define", `process.env.BORE_SERVER=${JSON.stringify(boreServer)}`,
  "--define", `process.env.BORE_PASSWORD=${JSON.stringify(borePassword)}`,
]);

build("claude-connect/index.ts", "dist/claude-connect/index.js", [
  "--define", `process.env.NODE_ENV="production"`,
]);
