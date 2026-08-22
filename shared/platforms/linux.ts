import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import {
  credentialsExist,
  readOAuthCredentials,
  writeOAuthCredentials,
} from "./fileStore";
import type { PlatformOps } from "./types";

const execFileAsync = promisify(execFile);

const linux: PlatformOps = {
  readOAuthCredentials,
  credentialsExist,
  writeOAuthCredentials,

  async getSystemName(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("hostname");
      return stdout.trim();
    } catch {
      return os.hostname();
    }
  },
};

export default linux;
