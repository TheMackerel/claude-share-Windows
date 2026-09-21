// Which Anthropic traffic the sharer is willing to carry. Both paths into the
// sharer — the MITM proxy and the relay endpoint — enforce this same list.

export const API_HOST = "api.anthropic.com";

// api.anthropic.com allowed paths
const API_ALLOWED_PATHS: Array<{ method: string | null; prefix: string }> = [
  { method: null, prefix: "/api/hello" },
  { method: "POST", prefix: "/v1/messages" },
  { method: "GET", prefix: "/v1/models" },
];

// api.anthropic.com paths that are always blocked regardless of method
const API_BLOCKED_PREFIXES = ["/v1/files", "/v1/fine_tuning", "/v1/assistants"];

export function isApiAllowed(method: string, reqPath: string): boolean {
  for (const blocked of API_BLOCKED_PREFIXES) {
    if (reqPath.startsWith(blocked)) return false;
  }
  for (const allowed of API_ALLOWED_PATHS) {
    if (reqPath.startsWith(allowed.prefix)) {
      if (allowed.method === null || allowed.method === method.toUpperCase())
        return true;
    }
  }
  return false;
}

// platform.anthropic.com allowed paths
export function isPlatformAnthropicAllowed(reqPath: string): boolean {
  return reqPath.startsWith("/api/auth/");
}

// platform.claude.com allowed paths
export function isPlatformClaudeAllowed(reqPath: string): boolean {
  return reqPath.startsWith("/v1/oauth/");
}
