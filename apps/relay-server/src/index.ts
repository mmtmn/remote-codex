import { createServer } from "node:http";

import {
  type PermissionPolicy,
  RelayIncomingSchema,
  type RelayOutgoingMessage,
  type RelayIncomingMessage,
  sha256Hex
} from "@remote-codex/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

interface SessionRecord {
  sessionId: string;
  pairingSecretHash: string;
  desktopPublicKey: string;
  permissions: PermissionPolicy;
  expiresAt: number;
  desktop: WebSocket | undefined;
  mobile: WebSocket | undefined;
}

interface ConnectionState {
  role?: "desktop" | "mobile";
  sessionId?: string;
  recentMessages: number[];
}

const SESSION_TTL_MS = Number.parseInt(process.env.SESSION_TTL_MS ?? "900000", 10);
const MAX_MESSAGES_PER_WINDOW = Number.parseInt(process.env.RATE_LIMIT_MAX_MESSAGES ?? "120", 10);
const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "10000", 10);
const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

const sessions = new Map<string, SessionRecord>();
const connectionState = new WeakMap<WebSocket, ConnectionState>();

const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

const socketServer = new WebSocketServer({ server });

socketServer.on("connection", (socket) => {
  connectionState.set(socket, { recentMessages: [] });

  socket.on("message", async (raw) => {
    try {
      enforceRateLimit(socket);
      const message = RelayIncomingSchema.parse(JSON.parse(raw.toString("utf8")));
      await handleIncoming(socket, message);
    } catch (error) {
      const parsed = z.instanceof(Error).safeParse(error);
      send(socket, {
        type: "error",
        code: "bad_request",
        message: parsed.success ? parsed.data.message : "Invalid websocket message."
      });
    }
  });

  socket.on("close", () => {
    unregisterSocket(socket);
  });
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`relay-server could not bind ${HOST}:${PORT} because that address is already in use.`);
    console.error("Choose a different PORT or stop the process already listening there.");
    process.exit(1);
  }

  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(formatStartupMessage(HOST, PORT));
});

setInterval(pruneExpiredSessions, 30_000).unref();

async function handleIncoming(socket: WebSocket, message: RelayIncomingMessage): Promise<void> {
  switch (message.type) {
    case "registerDesktop": {
      const expiresAt = Date.now() + SESSION_TTL_MS;
      const record: SessionRecord = {
        sessionId: message.sessionId,
        pairingSecretHash: message.pairingSecretHash,
        desktopPublicKey: message.desktopPublicKey,
        permissions: message.permissions,
        expiresAt,
        desktop: socket,
        mobile: undefined
      };

      sessions.set(message.sessionId, record);
      connectionState.set(socket, {
        role: "desktop",
        sessionId: message.sessionId,
        recentMessages: []
      });

      send(socket, {
        type: "registered",
        sessionId: message.sessionId,
        expiresAt: new Date(expiresAt).toISOString()
      });
      return;
    }

    case "joinMobile": {
      const session = sessions.get(message.sessionId);
      if (!session || session.expiresAt < Date.now()) {
        send(socket, {
          type: "error",
          code: "session_not_found",
          message: "The pairing session does not exist or has expired."
        });
        socket.close();
        return;
      }

      const incomingSecretHash = await sha256Hex(message.pairingSecret);
      if (incomingSecretHash !== session.pairingSecretHash) {
        send(socket, {
          type: "error",
          code: "invalid_pairing_secret",
          message: "The pairing secret is not valid for this session."
        });
        socket.close();
        return;
      }

      if (session.mobile && session.mobile !== socket) {
        session.mobile.close(4001, "superseded");
      }

      session.mobile = socket;
      connectionState.set(socket, {
        role: "mobile",
        sessionId: message.sessionId,
        recentMessages: []
      });

      send(socket, {
        type: "joined",
        sessionId: message.sessionId,
        desktopPublicKey: session.desktopPublicKey,
        permissions: session.permissions
      });

      if (session.desktop) {
        send(session.desktop, {
          type: "peerOnline",
          sessionId: message.sessionId,
          mobilePublicKey: message.mobilePublicKey
        });
      }
      return;
    }

    case "envelope": {
      const state = connectionState.get(socket);
      if (!state?.role || state.sessionId !== message.sessionId) {
        send(socket, {
          type: "error",
          code: "not_registered",
          message: "Register the websocket before sending encrypted envelopes."
        });
        return;
      }

      const session = sessions.get(message.sessionId);
      if (!session) {
        send(socket, {
          type: "error",
          code: "session_not_found",
          message: "No session exists for this envelope."
        });
        return;
      }

      const recipient = state.role === "desktop" ? session.mobile : session.desktop;
      if (!recipient || recipient.readyState !== recipient.OPEN) {
        send(socket, {
          type: "error",
          code: "peer_offline",
          message: "The other device is currently offline."
        });
        return;
      }

      send(recipient, message);
      return;
    }
  }
}

function enforceRateLimit(socket: WebSocket): void {
  const state = connectionState.get(socket);
  if (!state) {
    return;
  }

  const now = Date.now();
  state.recentMessages = state.recentMessages.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  state.recentMessages.push(now);

  if (state.recentMessages.length > MAX_MESSAGES_PER_WINDOW) {
    send(socket, {
      type: "error",
      code: "rate_limited",
      message: "Too many websocket messages received in a short period."
    });
    socket.close(4008, "rate_limited");
  }
}

function unregisterSocket(socket: WebSocket): void {
  const state = connectionState.get(socket);
  if (!state?.sessionId || !state.role) {
    return;
  }

  const session = sessions.get(state.sessionId);
  if (!session) {
    return;
  }

  if (state.role === "desktop" && session.desktop === socket) {
    if (session.mobile && session.mobile.readyState === session.mobile.OPEN) {
      send(session.mobile, {
        type: "peerOffline",
        sessionId: state.sessionId
      });
      session.mobile.close(4000, "desktop_offline");
    }
    sessions.delete(state.sessionId);
    return;
  }

  if (state.role === "mobile" && session.mobile === socket) {
    session.mobile = undefined;
    if (session.desktop && session.desktop.readyState === session.desktop.OPEN) {
      send(session.desktop, {
        type: "peerOffline",
        sessionId: state.sessionId
      });
    }
  }
}

function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt >= now) {
      continue;
    }

    if (session.desktop && session.desktop.readyState === session.desktop.OPEN) {
      send(session.desktop, {
        type: "error",
        code: "session_expired",
        message: "The pairing session expired."
      });
      session.desktop.close(4002, "expired");
    }

    if (session.mobile && session.mobile.readyState === session.mobile.OPEN) {
      send(session.mobile, {
        type: "error",
        code: "session_expired",
        message: "The pairing session expired."
      });
      session.mobile.close(4002, "expired");
    }

    sessions.delete(sessionId);
  }
}

function send(socket: WebSocket, message: RelayOutgoingMessage): void {
  if (socket.readyState !== socket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

function formatStartupMessage(host: string, port: number): string {
  const healthPath = "/healthz";
  if (host === "0.0.0.0" || host === "::") {
    return [
      `relay-server listening on ${host}:${port}`,
      `local health check: http://127.0.0.1:${port}${healthPath}`,
      "remote access still depends on firewall rules, NAT, and TLS/reverse-proxy setup."
    ].join("\n");
  }

  return `relay-server listening on http://${host}:${port}${healthPath}`;
}
