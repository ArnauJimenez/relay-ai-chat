import "dotenv/config";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import { Server, type DefaultEventsMap } from "socket.io";
import { z } from "zod";
import { logger } from "./services/logger.js";
import { streamAiResponse } from "./services/ai.service.js";
import { getCorsOrigin } from "./services/cors.service.js";
import { removeExpiredDemoAccounts, replyAsDemoBot } from "./services/demo.service.js";
import { getConfiguredLlmProviders } from "./services/llm-providers.js";
import { createRateLimiter } from "./services/rate-limit.service.js";
import { isDatabaseUnavailableError, prisma } from "./services/prisma.service.js";
import authRoutes from "./routes/auth.routes.js";
import roomRoutes from "./routes/rooms.routes.js";
import userRoutes from "./routes/users.routes.js";

interface SocketData {
  userId: string;
}

const onlineUsers = new Map<string, number>();
const demoCleanupIntervalMs = 60 * 60 * 1000;
let demoCleanupTimer: NodeJS.Timeout | undefined;

const messageSchema = z.object({
  roomId: z.string().uuid(),
  content: z.string().trim().min(1).max(10_000),
  triggerAi: z.boolean().optional(),
});

const messageRateLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
const aiRateLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

const corsOrigin = getCorsOrigin();

const app = express();
const httpServer = createServer(app);
const io = new Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>(httpServer, {
  cors: {
    origin: corsOrigin,
  },
});

// Render terminates TLS in front of the app; trust one hop so rate limits see the client IP.
app.set("trust proxy", 1);
app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});
app.use("/api/auth", authRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/users", userRoutes);
app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    next: express.NextFunction,
  ) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    if (isDatabaseUnavailableError(error)) {
      logger.error({ err: error }, "Database is unavailable");
      response
        .status(503)
        .setHeader("Retry-After", "5")
        .json({ error: "Database temporarily unavailable. Try again shortly." });
      return;
    }

    logger.error({ err: error }, "HTTP request failed");
    response.status(500).json({ error: "Internal server error" });
  },
);

io.use((socket, next) => {
  const token: unknown = socket.handshake.auth.token;
  const jwtSecret = process.env.JWT_SECRET;

  if (typeof token !== "string" || !jwtSecret) {
    next(new Error("Authentication required"));
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      next(new Error("Invalid authentication token"));
      return;
    }

    socket.data.userId = payload.sub;
    next();
  } catch {
    next(new Error("Invalid authentication token"));
  }
});

io.on("connection", (socket) => {
  onlineUsers.set(
    socket.data.userId,
    (onlineUsers.get(socket.data.userId) ?? 0) + 1,
  );

  socket.on("room:join", async (roomId: unknown) => {
    if (typeof roomId !== "string") {
      socket.emit("error:event", {
        message: "roomId debe ser una cadena.",
      });
      return;
    }

    try {
      const membership = await prisma.roomMember.findUnique({
        where: {
          userId_roomId: {
            userId: socket.data.userId,
            roomId,
          },
        },
        select: { roomId: true },
      });

      if (!membership) {
        socket.emit("error:event", {
          roomId,
          message: "No tienes acceso a esta sala.",
        });
        return;
      }

      await socket.join(roomId);
      socket.emit("room:joined", { roomId });
      const members = await prisma.roomMember.findMany({
        where: { roomId },
        select: { userId: true },
      });
      for (const member of members) {
        socket.emit("presence:update", {
          userId: member.userId,
          status: onlineUsers.has(member.userId) ? "online" : "offline",
        });
      }
      io.to(roomId).emit("presence:update", {
        userId: socket.data.userId,
        status: "online",
      });
    } catch (error) {
      logger.error({ err: error, roomId }, "Could not join chat room");
      socket.emit("error:event", {
        roomId,
        message: "No se pudo acceder a la sala.",
      });
    }
  });

  const relayTypingStatus = async (input: unknown, isTyping: boolean) => {
    if (
      typeof input !== "object" ||
      input === null ||
      !("roomId" in input) ||
      typeof input.roomId !== "string"
    ) {
      return;
    }

    const { roomId } = input;
    if (!socket.rooms.has(roomId)) {
      return;
    }

    try {
      const membership = await prisma.roomMember.findUnique({
        where: {
          userId_roomId: { userId: socket.data.userId, roomId },
        },
        select: { id: true },
      });
      if (!membership) {
        return;
      }

      socket.to(roomId).emit("typing:update", {
        roomId,
        userId: socket.data.userId,
        isTyping,
      });
    } catch (error) {
      logger.error(
        { err: error, roomId, userId: socket.data.userId },
        "Could not update typing status",
      );
    }
  };

  socket.on("typing:start", (input: unknown) => {
    void relayTypingStatus(input, true);
  });
  socket.on("typing:stop", (input: unknown) => {
    void relayTypingStatus(input, false);
  });
  socket.on("typing:update", (input: unknown) => {
    if (
      typeof input === "object" &&
      input !== null &&
      "isTyping" in input &&
      typeof input.isTyping === "boolean"
    ) {
      void relayTypingStatus(input, input.isTyping);
    }
  });

  socket.on("room:leave", async (roomId: unknown) => {
    if (typeof roomId !== "string" || !socket.rooms.has(roomId)) {
      return;
    }

    socket.to(roomId).emit("typing:update", {
      roomId,
      userId: socket.data.userId,
      isTyping: false,
    });
    await socket.leave(roomId);
  });

  socket.on("message:send", async (input: unknown) => {
    const parsed = messageSchema.safeParse(input);
    if (!parsed.success) {
      socket.emit("error:event", {
        message: "El mensaje enviado no es válido.",
      });
      return;
    }

    const messageDecision = messageRateLimiter.consume(socket.data.userId);
    if (!messageDecision.allowed) {
      socket.emit("error:event", {
        message: `Vas demasiado rápido. Inténtalo de nuevo en ${messageDecision.retryAfterSeconds}s.`,
      });
      return;
    }

    const { roomId, content, triggerAi = false } = parsed.data;

    try {
      const membership = await prisma.roomMember.findUnique({
        where: {
          userId_roomId: {
            userId: socket.data.userId,
            roomId,
          },
        },
        select: {
          room: {
            select: { type: true },
          },
        },
      });

      if (!membership) {
        socket.emit("error:event", {
          roomId,
          message: "No tienes acceso a esta sala.",
        });
        return;
      }

      await socket.join(roomId);
      const message = await prisma.message.create({
        data: {
          roomId,
          senderId: socket.data.userId,
          content,
        },
      });

      io.to(roomId).emit("message:new", message);

      if (membership.room.type === "DIRECT") {
        void replyAsDemoBot({ roomId, senderId: socket.data.userId, io });
      }

      if (triggerAi || membership.room.type === "AI_ASSISTANT") {
        const aiDecision = aiRateLimiter.consume(socket.data.userId);
        if (aiDecision.allowed) {
          void streamAiResponse(roomId, content, io);
        } else {
          socket.emit("error:event", {
            roomId,
            message: `Límite del asistente alcanzado. Inténtalo de nuevo en ${aiDecision.retryAfterSeconds}s.`,
          });
        }
      }
    } catch (error) {
      logger.error(
        { err: error, roomId, userId: socket.data.userId },
        "Could not save chat message",
      );
      socket.emit("error:event", {
        roomId,
        message: "No se pudo guardar el mensaje.",
      });
    }
  });

  socket.on("disconnecting", () => {
    const isLastConnection = (onlineUsers.get(socket.data.userId) ?? 1) <= 1;
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        socket.to(roomId).emit("typing:update", {
          roomId,
          userId: socket.data.userId,
          isTyping: false,
        });
        if (isLastConnection) {
          socket.to(roomId).emit("presence:update", {
            userId: socket.data.userId,
            status: "offline",
          });
        }
      }
    }
  });

  socket.on("disconnect", () => {
    const connections = onlineUsers.get(socket.data.userId) ?? 1;
    if (connections > 1) {
      onlineUsers.set(socket.data.userId, connections - 1);
      return;
    }

    onlineUsers.delete(socket.data.userId);
  });
});

async function start(): Promise<void> {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET must be set");
  }

  await prisma.$connect();

  if (getConfiguredLlmProviders().length === 0) {
    logger.warn("No LLM API key is configured; AI assistant replies will fail");
  }

  await removeExpiredDemoAccounts().catch((error: unknown) => {
    logger.error({ err: error }, "Could not remove expired demo accounts");
  });
  demoCleanupTimer = setInterval(() => {
    void removeExpiredDemoAccounts().catch((error: unknown) => {
      logger.error({ err: error }, "Could not remove expired demo accounts");
    });
  }, demoCleanupIntervalMs);

  const port = Number(process.env.PORT ?? 3000);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, () => {
      httpServer.off("error", reject);
      logger.info({ port }, "Chat server is listening");
      resolve();
    });
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down chat server");
  clearInterval(demoCleanupTimer);
  await new Promise<void>((resolve, reject) => {
    io.close((error) => (error ? reject(error) : resolve()));
  });
  await prisma.$disconnect();
}


function handleShutdown(signal: string): void {
  void shutdown(signal).catch((error: unknown) => {
    logger.error({ err: error, signal }, "Could not shut down cleanly");
    process.exitCode = 1;
  });
}

export { app, httpServer, io };

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.once("SIGINT", () => handleShutdown("SIGINT"));
  process.once("SIGTERM", () => handleShutdown("SIGTERM"));

  void start().catch((error: unknown) => {
    logger.fatal({ err: error }, "Could not start chat server");
    process.exitCode = 1;
  });
}
