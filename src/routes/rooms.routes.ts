import { Router } from "express";
import { Prisma, RoomType } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { prisma } from "../services/prisma.service.js";

const router = Router();

const createRoomSchema = z.object({
  type: z.nativeEnum(RoomType).default(RoomType.GROUP),
  name: z.string().trim().min(1).max(100).nullable().optional(),
  memberIds: z.array(z.string().uuid()).max(100).default([]),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const roomInclude = {
  members: {
    select: {
      user: {
        select: {
          id: true,
          username: true,
          avatarUrl: true,
        },
      },
    },
  },
} satisfies Prisma.RoomInclude;

/** A DIRECT room is the one whose members are exactly this pair of users. */
function findDirectRoom(memberIds: string[]) {
  return prisma.room.findFirst({
    where: {
      type: RoomType.DIRECT,
      AND: memberIds.map((memberId) => ({ members: { some: { userId: memberId } } })),
      members: { every: { userId: { in: memberIds } } },
    },
    include: roomInclude,
  });
}

router.use(requireAuth);

router.post("/", async (request, response) => {
  const parsed = createRoomSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid room details" });
    return;
  }

  const { memberIds, type } = parsed.data;
  const userId = request.userId;
  const uniqueMemberIds = [...new Set([userId, ...memberIds])];

  if (type === RoomType.DIRECT && uniqueMemberIds.length !== 2) {
    response.status(400).json({
      error: "Direct messages need exactly one other member",
    });
    return;
  }

  // Reuse the existing conversation instead of creating a second DM between the same two users.
  // The sorted key is a unique column, so two concurrent requests cannot both insert one.
  const directKey = type === RoomType.DIRECT ? [...uniqueMemberIds].sort().join(":") : undefined;
  if (type === RoomType.DIRECT) {
    const existing = await findDirectRoom(uniqueMemberIds);
    if (existing) {
      response.status(200).json(existing);
      return;
    }
  }

  try {
    const room = await prisma.room.create({
      data: {
        type,
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(directKey === undefined ? {} : { directKey }),
        members: {
          create: uniqueMemberIds.map((memberId) => ({ userId: memberId })),
        },
      },
      include: roomInclude,
    });

    response.status(201).json(room);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      response.status(400).json({ error: "One or more members do not exist" });
      return;
    }

    if (
      directKey !== undefined &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await prisma.room.findUnique({
        where: { directKey },
        include: roomInclude,
      });
      if (existing) {
        response.status(200).json(existing);
        return;
      }
    }

    throw error;
  }
});

router.get("/", async (request, response) => {
  const userId = request.userId;
  const rooms = await prisma.room.findMany({
    where: {
      members: {
        some: { userId },
      },
    },
    include: {
      ...roomInclude,
      messages: {
        select: { createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  rooms.sort((left, right) => {
    const leftActivity = left.messages[0]?.createdAt ?? left.createdAt;
    const rightActivity = right.messages[0]?.createdAt ?? right.createdAt;
    return rightActivity.getTime() - leftActivity.getTime();
  });
  response.json(rooms.map(({ messages: _messages, ...room }) => room));
});

router.get("/:roomId/messages", async (request, response) => {
  const roomIdParsed = z.string().uuid().safeParse(request.params.roomId);
  const pagination = paginationSchema.safeParse(request.query);
  if (!roomIdParsed.success || !pagination.success) {
    response.status(400).json({ error: "Invalid room or pagination details" });
    return;
  }

  const roomId = roomIdParsed.data;
  const userId = request.userId;
  const membership = await prisma.roomMember.findUnique({
    where: {
      userId_roomId: { userId, roomId },
    },
    select: { id: true },
  });

  if (!membership) {
    response.status(404).json({ error: "Room not found" });
    return;
  }

  const { page, limit } = pagination.data;
  const messages = await prisma.message.findMany({
    where: { roomId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: (page - 1) * limit,
    take: limit,
    include: {
      sender: {
        select: {
          username: true,
          avatarUrl: true,
        },
      },
    },
  });

  response.json({ messages, page, limit });
});

export default router;
