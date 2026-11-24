import type { Server } from "socket.io";
import { logger } from "./logger.js";
import {
  describeProviderError,
  generateWithFailover,
  getConfiguredLlmProviders,
  getLlmSecrets,
  redactSecrets,
} from "./llm-providers.js";
import { prisma } from "./prisma.service.js";

const defaultProviderTimeoutMs = 45_000;
const retryBaseDelayMs = 1_000;

function getProviderTimeoutMs(): number {
  const configured = Number(process.env.AI_PROVIDER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : defaultProviderTimeoutMs;
}

export async function streamAiResponse(
  roomId: string,
  prompt: string,
  ioInstance: Server,
): Promise<void> {
  let messageId: string | undefined;
  let content = "";
  const secrets = getLlmSecrets();

  try {
    const message = await prisma.message.create({
      data: {
        roomId,
        senderId: null,
        isAi: true,
        content: "",
        status: "STREAMING",
      },
      select: {
        id: true,
        createdAt: true,
      },
    });
    messageId = message.id;

    ioInstance.to(roomId).emit("ai:stream_start", {
      messageId,
      roomId,
      createdAt: message.createdAt,
    });

    const providers = getConfiguredLlmProviders();
    if (providers.length === 0) {
      throw new Error("No LLM API key is configured (GEMINI_API_KEY, DEEPSEEK_API_KEY or XAI_API_KEY)");
    }

    const result = await generateWithFailover(prompt, providers, {
      timeoutMs: getProviderTimeoutMs(),
      retryBaseDelayMs,
      onChunk: (chunk) => {
        content += chunk;
        ioInstance.to(roomId).emit("ai:stream_chunk", {
          messageId,
          roomId,
          chunk,
        });
      },
      onProviderError: ({ provider, attempt, error }) => {
        const details = describeProviderError(error, secrets);
        logger.warn(
          {
            provider,
            attempt,
            statusCode: details.statusCode,
            apiCode: details.code,
            errorMessage: details.message,
            roomId,
            messageId,
          },
          "LLM provider attempt failed",
        );
      },
    });
    logger.info({ provider: result.provider, roomId, messageId }, "AI response generated");

    await prisma.message.update({
      where: { id: messageId },
      data: {
        content,
        status: "COMPLETED",
      },
    });

    ioInstance.to(roomId).emit("ai:stream_end", {
      messageId,
      roomId,
      content,
      status: "COMPLETED",
    });
  } catch (error) {
    const details = describeProviderError(error, secrets);
    logger.error(
      {
        err: {
          type: details.name,
          message: details.message,
          ...(error instanceof Error && error.stack
            ? { stack: redactSecrets(error.stack, secrets) }
            : {}),
        },
        statusCode: details.statusCode,
        apiCode: details.code,
        roomId,
        messageId,
      },
      "AI response streaming failed",
    );

    if (messageId) {
      try {
        await prisma.message.update({
          where: { id: messageId },
          data: {
            content,
            status: "FAILED",
          },
        });
      } catch (persistenceError) {
        logger.error(
          { err: persistenceError, roomId, messageId },
          "Could not persist failed AI message status",
        );
      }

      ioInstance.to(roomId).emit("ai:stream_end", {
        messageId,
        roomId,
        content,
        status: "FAILED",
        ...(process.env.NODE_ENV !== "production"
          ? {
              error: details.message,
              ...(details.statusCode === undefined
                ? {}
                : { errorStatus: details.statusCode }),
              ...(details.code === undefined ? {} : { errorCode: details.code }),
            }
          : {}),
      });
    }

    ioInstance.to(roomId).emit("error:event", {
      roomId,
      messageId,
      message:
        process.env.NODE_ENV === "production"
          ? "No se pudo completar la respuesta del asistente."
          : details.message,
    });
  }
}
