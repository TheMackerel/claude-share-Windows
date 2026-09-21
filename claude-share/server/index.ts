import https from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { Hono } from "hono";

import { logger } from "../logger";
import { API_HOST, isApiAllowed } from "../proxy/policy";
import { logRequest, setResponseStatus } from "../proxy/requestLog";
import { getAccessToken } from "../proxy/token";
import {
  getSession,
  checkPairingCode,
  checkMachineAuth,
  addMachine,
  encryptConnectionFile,
  isSessionExpired,
  addMachineSession,
  endMachineSession,
  heartbeatMachineSession,
  type ConnectionFile,
  type SharerAccount,
} from "../session/manager";

interface Urls {
  public: string | null;
  lan: string | null;
}

// Dropped on the way out: hop-by-hop, the receiver's proxy credentials, and
// anything that would pin the body's original framing.
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "proxy-authorization",
  "content-length",
  "transfer-encoding",
  "x-forwarded-for",
  "x-real-ip",
]);

// Dropped on the way back: anything that could leak the sharer's identity, plus
// framing headers the re-sent response sets for itself.
const SKIP_RESPONSE_HEADERS = new Set([
  "authorization",
  "set-cookie",
  "x-api-key",
  "anthropic-organization-id",
  "connection",
  "content-length",
  "transfer-encoding",
]);

/** Sends one request on to the Anthropic API, streaming the body through. */
function forwardToApi(
  method: string,
  pathWithQuery: string,
  headers: Record<string, string>,
  body: ReadableStream<Uint8Array> | null,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: API_HOST, port: 443, path: pathWithQuery, method, headers },
      resolve,
    );
    req.on("error", reject);
    if (body) {
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
        .on("error", reject)
        .pipe(req);
    } else {
      req.end();
    }
  });
}

export function createApiApp(
  urls: Urls,
  caPem: string,
  sharerAccount: SharerAccount | null,
  systemName: string,
): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (p === "/health" || p === "/pair" || p.startsWith("/connect/")) {
      return next();
    }
    const session = getSession();
    const auth = c.req.header("proxy-authorization");
    if (!auth || !session || !checkMachineAuth(session, auth)) {
      return c.text("Unauthorized", 407);
    }
    return next();
  });

  app.get("/health", (c) => {
    const session = getSession();
    return c.json({
      ok: true,
      sessionActive: !!session && !isSessionExpired(session),
      sessionId: session?.id ?? null,
      // Tells a receiver it can point ANTHROPIC_BASE_URL at /relay instead of
      // routing claude through the MITM proxy. Absent on older sharers.
      relay: true,
    });
  });

  /**
   * ALL /relay/* — forwards an Anthropic API call with the sharer's token.
   *
   * Same job as the MITM proxy, minus the interception: the receiver reaches
   * this over ordinary TLS, so its claude never has to trust a generated CA.
   * Responses stream straight through, which SSE depends on.
   */
  app.all("/relay/*", async (c) => {
    const url = new URL(c.req.url);
    const reqPath = url.pathname.slice("/relay".length);
    const method = c.req.method;

    if (!isApiAllowed(method, reqPath)) {
      logRequest(method, API_HOST, reqPath, "blocked");
      return c.text("Not allowed by claude-share policy", 403);
    }

    const logId = logRequest(method, API_HOST, reqPath, "allowed");

    const headers: Record<string, string> = {};
    for (const [name, value] of c.req.raw.headers) {
      if (SKIP_REQUEST_HEADERS.has(name)) continue;
      headers[name] = value;
    }
    headers["host"] = API_HOST;
    headers["authorization"] = `Bearer ${getAccessToken()}`;

    let upstream: IncomingMessage;
    try {
      upstream = await forwardToApi(
        method,
        `${reqPath}${url.search}`,
        headers,
        c.req.raw.body,
      );
    } catch (err) {
      logger.error("[relay] upstream request failed", err);
      setResponseStatus(logId, 502);
      return c.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: "[claude-share] The sharer could not reach Anthropic.",
          },
        },
        502,
      );
    }

    const status = upstream.statusCode ?? 502;
    setResponseStatus(logId, status);

    // A 401 means the sharer's own token is invalid or expired — say so instead
    // of letting it read as a receiver-side credentials problem.
    if (status === 401) {
      upstream.resume();
      return c.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message:
              "[claude-share] The sharer's Anthropic token is invalid or expired. ",
          },
        },
        401,
      );
    }

    const respHeaders = new Headers();
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (SKIP_RESPONSE_HEADERS.has(name) || value === undefined) continue;
      respHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
    }

    return new Response(Readable.toWeb(upstream) as ReadableStream, {
      status,
      headers: respHeaders,
    });
  });

  /** GET /connect/:code — human-readable hint when someone opens the URL in a browser */
  app.get("/connect/:code", (c) => {
    const url = c.req.url;
    return c.text(
      `This is a claude-share connect link — it cannot be opened in a browser.\n\n` +
        `Run this instead:\n\n  claude-connect --share "${url}"\n`,
      200,
      { "Content-Type": "text/plain; charset=utf-8" },
    );
  });

  /** POST /pair — one-time pairing with a machine */
  app.post("/pair", async (c) => {
    const session = getSession();
    if (!session || isSessionExpired(session))
      return c.json({ error: "No active session" }, 503);

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const body = await c.req.json<{ code?: string; name?: string }>();
    const code = body.code?.trim() ?? "";
    const name = body.name?.trim() ?? "unknown device";

    if (!checkPairingCode(session, ip, code))
      return c.json({ error: "Invalid pairing code" }, 401);

    const machine = addMachine(session, name);

    const file: ConnectionFile = {
      publicServerUrl: urls.public,
      lanServerUrl: urls.lan,
      sessionId: session.id,
      sharedUntil: session.sharedUntil.toISOString(),
      caPem,
      sharerAccount,
      systemName,
      proxyUser: machine.id,
      proxyPass: machine.proxyPass,
    };

    const blob = encryptConnectionFile(session, file);
    return c.json({ blob, machineId: machine.id });
  });

  /** POST /session/start — receiver opened a Claude session */
  app.post("/session/start", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId } = await c.req.json<{ machineId: string }>();
    const ms = addMachineSession(session, machineId);
    if (!ms) return c.json({ error: "Machine not found" }, 404);
    return c.json({ ok: true, sessionId: ms.id });
  });

  /** POST /session/end — receiver closed a Claude session */
  app.post("/session/end", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId, sessionId } = await c.req.json<{
      machineId: string;
      sessionId: string;
    }>();
    endMachineSession(session, machineId, sessionId);
    return c.json({ ok: true });
  });

  /** POST /session/heartbeat — receiver is still alive */
  app.post("/session/heartbeat", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId, sessionId } = await c.req.json<{
      machineId: string;
      sessionId: string;
    }>();
    heartbeatMachineSession(session, machineId, sessionId);
    return c.json({ ok: true });
  });

  /** GET /machines — list machines and their sessions */
  app.get("/machines", (c) => {
    const session = getSession();
    if (!session) return c.json({ machines: [] });
    const machines = [...session.machines.values()].map((m) => ({
      id: m.id,
      name: m.name,
      pairedAt: m.pairedAt.toISOString(),
      sessions: [...m.sessions.values()].map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
        active: s.active,
      })),
    }));
    return c.json({ machines, sharedUntil: session.sharedUntil.toISOString() });
  });

  return app;
}
