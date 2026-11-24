import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import type { Server } from "socket.io";
import { logger } from "./logger.js";
import { prisma } from "./prisma.service.js";

export const demoBotUsername = "relay_guide";

const demoEmailDomain = "demo.relay.invalid";
const guestTtlMs = 24 * 60 * 60 * 1000;
const botReplyDelayMs = 1_200;
const welcomeMessage =
  "¡Hola! Soy el bot de demostración de Relay. Esta conversación es privada: solo tú y yo podemos verla. Escribe algo para probar el chat en tiempo real.";
const botReplies = [
  "Recibido. Los mensajes se guardan y llegan en tiempo real a todos los miembros de la sala.",
  "¡Buena pregunta! Prueba también el asistente de IA desde la barra lateral.",
  "Cada invitado tiene su propia sesión temporal. Cuando expira, sus datos se eliminan.",
];

const guestSelect = {
  id: true,
  email: true,
  username: true,
  avatarUrl: true,
  createdAt: true,
} as const;

// Nobody knows the preimage, so guest and bot accounts can never be logged into with a password.
let unusablePasswordHash: Promise<string> | undefined;
function getUnusablePasswordHash(): Promise<string> {
  unusablePasswordHash ??= hash(randomUUID(), 12).catch((error: unknown) => {
    unusablePasswordHash = undefined;
    throw error;
  });
  return unusablePasswordHash;
}

async function ensureDemoBot(): Promise<{ id: string }> {
  const existing = await prisma.user.findUnique({
    where: { username: demoBotUsername },
    select: { id: true },
  });
  if (existing) {
    return existing;
  }

  return prisma.user.create({
    data: {
      email: `relay-guide@${demoEmailDomain}`,
      username: demoBotUsername,
      passwordHash: await getUnusablePasswordHash(),
    },
    select: { id: true },
  });
}

let demoBot: Promise<{ id: string }> | undefined;
function getDemoBot(): Promise<{ id: string }> {
  demoBot ??= ensureDemoBot().catch((error: unknown) => {
    demoBot = undefined;
    throw error;
  });
  return demoBot;
}

/**
 * Creates an isolated guest account with a private DM to the demo bot and an AI assistant room.
 * Each guest gets its own DM, so the bot never shares a conversation between two guests.
 */
export async function createGuestSession() {
  const bot = await getDemoBot();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

  return prisma.user.create({
    data: {
      email: `guest-${suffix}@${demoEmailDomain}`,
      username: `guest_${suffix}`,
      passwordHash: await getUnusablePasswordHash(),
      isDemo: true,
      memberships: {
        create: [
          {
            room: {
              create: {
                type: "DIRECT",
                members: { create: { userId: bot.id } },
                messages: { create: { senderId: bot.id, content: welcomeMessage } },
              },
            },
          },
          {
            room: {
              create: { name: "Asistente IA de demo", type: "AI_ASSISTANT" },
            },
          },
        ],
      },
    },
    select: guestSelect,
  });
}

/** Deletes expired guest accounts and the demo DMs they leave behind. Returns the number of guests removed. */
export async function removeExpiredDemoAccounts(now = Date.now()): Promise<number> {
  const { count } = await prisma.user.deleteMany({
    where: { isDemo: true, createdAt: { lt: new Date(now - guestTtlMs) } },
  });

  await prisma.room.deleteMany({
    where: {
      OR: [
        { members: { none: {} } },
        { type: "DIRECT", members: { every: { user: { username: demoBotUsername } } } },
      ],
    },
  });

  return count;
}

/** Replies from the demo bot when a guest writes in its DM. Canned text, so it costs no LLM calls. */
export async function replyAsDemoBot({
  roomId,
  senderId,
  io,
}: {
  roomId: string;
  senderId: string;
  io: Server;
}): Promise<void> {
  try {
    const bot = await getDemoBot();
    if (senderId === bot.id) {
      return;
    }

    const botMembership = await prisma.roomMember.findUnique({
      where: { userId_roomId: { userId: bot.id, roomId } },
      select: { id: true },
    });
    if (!botMembership) {
      return;
    }

    io.to(roomId).emit("typing:update", { roomId, userId: bot.id, isTyping: true });
    setTimeout(() => {
      const content = botReplies[Math.floor(Math.random() * botReplies.length)] ?? "Recibido.";
      void prisma.message
        .create({ data: { roomId, senderId: bot.id, content } })
        .then((message) => {
          io.to(roomId).emit("typing:update", { roomId, userId: bot.id, isTyping: false });
          io.to(roomId).emit("message:new", message);
        })
        .catch((error: unknown) => {
          logger.error({ err: error, roomId }, "Could not save demo bot reply");
        });
    }, botReplyDelayMs);
  } catch (error) {
    logger.error({ err: error, roomId }, "Could not schedule demo bot reply");
  }
}
