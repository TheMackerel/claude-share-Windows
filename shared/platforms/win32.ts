import os from "node:os";

import { credentialsExist, readOAuthCredentials, writeOAuthCredentials } from "./fileStore";
import type { PlatformOps } from "./types";

// %USERPROFILE%\.claude\.credentials.json — same JSON store Claude Code uses on
// Linux; on Windows it is protected by the user profile's ACL rather than 0600.
const win32: PlatformOps = {
  readOAuthCredentials,
  credentialsExist,
  writeOAuthCredentials,

  async getSystemName(): Promise<string> {
    return process.env["COMPUTERNAME"]?.trim() || os.hostname();
  },
};

export default win32;
