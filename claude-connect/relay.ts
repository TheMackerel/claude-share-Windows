import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

import { logger } from "./logger";

export interface Relay {
  /** Loopback base URL to hand to claude as ANTHROPIC_BASE_URL */
  url: string;
  close(): void;
}

/**
 * Loopback HTTP endpoint that forwards Anthropic API calls to the sharer.
 *
 * claude talks to it in plain HTTP over 127.0.0.1, so nothing it sends leaves
 * the machine unencrypted and it never has to trust the session CA — which the
 * native Windows build ignores. This process does the TLS to the sharer itself,
 * with the CA passed in code. Bodies stream in both directions so SSE works.
 */
export async function startRelay(
  serverUrl: string,
  caPem: string,
  proxyAuth: string,
): Promise<Relay> {
  const target = new URL(serverUrl);
  const port = parseInt(target.port || "443", 10);

  const server = http.createServer((req, res) => {
    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["connection"];
    headers["proxy-authorization"] = proxyAuth;

    const upstream = https.request(
      {
        hostname: target.hostname,
        port,
        path: `/relay${req.url ?? "/"}`,
        method: req.method,
        headers,
        ca: caPem,
        // node cannot derive the servername for IP-based URLs on its own
        servername: target.hostname,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );

    upstream.on("error", (err) => {
      logger.error("Relay could not reach the sharer", err);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: "[claude-share] Lost the connection to the sharer.",
          },
        }),
      );
    });

    req.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}
