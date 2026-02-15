import type { OpenClawPluginApi, ChannelGatewayContext } from "openclaw/plugin-sdk";
import { createConnection } from "node:net";
import {
  dispatchInboundMessageWithBufferedDispatcher,
  loadConfig,
  createTypingCallbacks,
} from "openclaw/plugin-sdk";

const SOCKET_PATH = "/run/user/1000/agithon.sock";

// Keep track of socket outside for handleInbound
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientSocket: any = null;

export const register = (api: OpenClawPluginApi) => {
  api.logger.info("Initializing Agithon native bridge...");

  api.registerChannel({
    id: "agithon",
    meta: {
      id: "agithon",
      label: "Agithon",
      selectionLabel: "Agithon Bridge",
      docsPath: "/channels/agithon",
      blurb: "Native bridge to local Agithon agent",
    },
    capabilities: {
      chatTypes: ["direct"],
      nativeCommands: true,
    },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ accountId: "default" }),
      isEnabled: () => true,
      isConfigured: () => true,
      unconfiguredReason: () => "",
      describeAccount: () => ({ accountId: "default", configured: true, enabled: true }),
    },
    directory: {
      listPeers: async () => [{ kind: "user", id: "agent", name: "Agithon Agent" }],
      listGroups: async () => [],
    },
    messaging: {
      targetResolver: {
        looksLikeId: (raw) => {
          return raw === "agent" || raw === "@agithon" || raw === "default";
        },
      },
    },
    gateway: {
      startAccount: async (ctx: ChannelGatewayContext) => {
        ctx.runtime.log("Starting Agithon gateway...");

        const connect = () => {
          const socket = createConnection(SOCKET_PATH);
          clientSocket = socket;

          let buffer = "";

          socket.on("connect", () => {
            ctx.runtime.log("Connected to Agithon socket");
            ctx.setStatus({ ...ctx.getStatus(), connected: true, running: true });
          });

          socket.on("data", (chunk) => {
            const raw = chunk.toString();
            ctx.runtime.log(`[AGITHON-BRIDGE] Received: ${raw.substring(0, 200)}`);
            buffer += raw;
            const lines = buffer.split("\n");
            if (buffer.endsWith("\n")) {
              buffer = "";
            } else {
              buffer = lines.pop() ?? "";
            }

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) {
                continue;
              }
              try {
                const msg = JSON.parse(trimmed);
                void handleInbound(msg, ctx);
              } catch (e) {
                ctx.runtime.error(`Agithon JSON error: ${e} | Line: ${trimmed}`);
              }
            }
          });

          socket.on("close", () => {
            ctx.runtime.log("Agithon socket closed, retrying...");
            ctx.setStatus({ ...ctx.getStatus(), connected: false });
            clientSocket = null;
            setTimeout(connect, 3000);
          });

          socket.on("error", (err) => {
            ctx.runtime.error(`Agithon socket error: ${err}`);
          });
        };

        connect();
      },
      stopAccount: async () => {
        clientSocket?.destroy();
        clientSocket = null;
      },
    },
    outbound: {
      deliveryMode: "direct",
      resolveTarget: (params) => {
        return { ok: true, to: params.to || "default" };
      },
      sendText: async (ctx) => {
        console.log(`[AGITHON-BRIDGE] sendText called: ${ctx.text}`);
        if (!clientSocket || clientSocket.destroyed) {
          return {
            delivered: false,
            error: "Socket not connected",
            channel: "agithon",
            messageId: undefined,
          };
        }

        const msg = {
          role: "user",
          content: ctx.text,
        };

        clientSocket.write(JSON.stringify(msg) + "\n");
        return { delivered: true, messageId: Date.now().toString(), channel: "agithon" };
      },
      sendMedia: async (ctx) => {
        if (!clientSocket || clientSocket.destroyed) {
          return {
            delivered: false,
            error: "Socket not connected",
            channel: "agithon",
            messageId: undefined,
          };
        }
        const msg = {
          role: "user",
          content: `[Media: ${ctx.mediaUrl}] ${ctx.text}`,
        };
        clientSocket.write(JSON.stringify(msg) + "\n");
        return { delivered: true, messageId: Date.now().toString(), channel: "agithon" };
      },
    },
  });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleInbound(evt: any, ctx: ChannelGatewayContext) {
  let text = "";
  if (evt.event === "TextDelta") {
    text = evt.data.delta;
  } else if (evt.role === "assistant") {
    text = typeof evt.content === "string" ? evt.content : JSON.stringify(evt.content);
  } else {
    return;
  }

  if (!text) {
    return;
  }

  ctx.runtime.log(`Inbound from Agithon: ${text.substring(0, 50)}...`);

  const cfg = loadConfig();

  const msgCtx = {
    Body: text,
    From: "agent",
    To: "openclaw",
    OriginatingChannel: "agithon",
    OriginatingTo: "default",
    Provider: "agithon",
    Surface: "agithon",
    Timestamp: Date.now(),
    ConversationLabel: "Agithon Bridge",
    ChatType: "direct",
  };

  try {
    await dispatchInboundMessageWithBufferedDispatcher({
      // @ts-ignore
      ctx: msgCtx,
      cfg,
      dispatcherOptions: {
        deliver: async (payload) => {
          if (payload.text) {
            if (!clientSocket) {
              return;
            }
            const reply = { role: "user", content: payload.text };
            clientSocket.write(JSON.stringify(reply) + "\n");
          }
        },
        onSkip: () => {},
        onError: (err) => {
          ctx.runtime.error(`Agithon dispatch error: ${err}`);
        },
        onReplyStart: createTypingCallbacks({
          start: async () => {},
          onStartError: () => {},
        }).onReplyStart,
      },
    });
  } catch (err) {
    ctx.runtime.error(`Agithon top-level dispatch error: ${err}`);
  }
}
