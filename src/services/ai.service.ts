import type { Server } from "socket.io";
import { logger } from "./logger.js";
import {
  describeProviderError,
  generateWithFailover,
  getConfiguredLlmProviders,
  getLlmProviderTimeoutMs,
  getLlmSecrets,
  redactSecrets,
} from "./llm-providers.js";
import { prisma } from "./prisma.service.js";

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
      throw new Error(
        "No LLM API key is configured (GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY or CEREBRAS_API_KEY)",
      );
    }

    const result = await generateWithFailover(prompt, providers, {
      timeoutMs: getLlmProviderTimeoutMs(),
      onChunk: (chunk) => {
        content += chunk;
        ioInstance.to(roomId).emit("ai:stream_chunk", {
          messageId,
          roomId,
          chunk,
        });
      },
      onProviderError: ({ provider, model, attempt, reason, error }) => {
        const details = describeProviderError(error, secrets);
        logger.warn(
          {
            provider,
            model,
            attempt,
            failureReason: reason,
            errorType: details.name,
            statusCode: details.statusCode,
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
        errorType: details.name,
        failureReason: details.reason,
        statusCode: details.statusCode,
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
          {
            errorType: persistenceError instanceof Error ? persistenceError.name : "Error",
            roomId,
            messageId,
          },
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
