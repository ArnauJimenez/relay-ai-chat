import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "unit-test-secret";

const prismaMock = vi.hoisted(() => ({
  user: { findMany: vi.fn() },
  room: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
}));

vi.mock("../src/services/prisma.service.js", () => ({ prisma: prismaMock }));

const { default: userRoutes } = await import("../src/routes/users.routes.js");
const { default: roomRoutes } = await import("../src/routes/rooms.routes.js");

const app = express();
app.use(express.json());
app.use("/api/users", userRoutes);
app.use("/api/rooms", roomRoutes);

function tokenFor(userId: string): string {
  return jwt.sign({ userId, username: "tester" }, process.env.JWT_SECRET!, { subject: userId });
}

const publicSelect = { id: true, email: true, username: true, avatarUrl: true };

function directRoom(memberIds: string[]) {
  return {
    id: randomUUID(),
    name: null,
    type: "DIRECT",
    createdAt: new Date(),
    updatedAt: new Date(),
    members: memberIds.map((id) => ({ user: { id, username: `user_${id.slice(0, 6)}`, avatarUrl: null } })),
  };
}

describe("GET /api/users/search", () => {
  beforeEach(() => {
    prismaMock.user.findMany.mockReset();
    prismaMock.user.findMany.mockResolvedValue([]);
  });

  it("requires a valid JWT", async () => {
    await request(app).get("/api/users/search?q=ana").expect(401);
  });

  it.each([
    ["missing q", "/api/users/search"],
    ["one character", "/api/users/search?q=a"],
    ["whitespace only", "/api/users/search?q=%20%20%20"],
    ["over 60 characters", `/api/users/search?q=${"a".repeat(61)}`],
  ])("rejects %s with 400", async (_label, url) => {
    await request(app).get(url).set("Authorization", `Bearer ${tokenFor(randomUUID())}`).expect(400);
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  it("searches case-insensitively, excludes the caller and guests, and limits results to 8", async () => {
    const caller = randomUUID();
    prismaMock.user.findMany.mockResolvedValue([
      { id: randomUUID(), email: "ana@example.com", username: "ana", avatarUrl: null },
    ]);

    const response = await request(app)
      .get("/api/users/search?q=%20%20ANA%20")
      .set("Authorization", `Bearer ${tokenFor(caller)}`)
      .expect(200);

    const args = prismaMock.user.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({
      id: { not: caller },
      isDemo: false,
      OR: [
        { email: { contains: "ANA", mode: "insensitive" } },
        { username: { contains: "ANA", mode: "insensitive" } },
      ],
    });
    expect(args.take).toBe(8);
    expect(response.body).toHaveLength(1);
  });

  it("selects only public fields, never credentials or internal metadata", async () => {
    await request(app)
      .get("/api/users/search?q=ana")
      .set("Authorization", `Bearer ${tokenFor(randomUUID())}`)
      .expect(200);

    const args = prismaMock.user.findMany.mock.calls[0]?.[0];
    expect(args.select).toEqual(publicSelect);
    expect(args.select).not.toHaveProperty("passwordHash");
    expect(args.select).not.toHaveProperty("lastSeen");
  });

  it("returns 429 after 30 searches per user in a minute", async () => {
    const caller = randomUUID();
    const auth = `Bearer ${tokenFor(caller)}`;
    for (let attempt = 0; attempt < 30; attempt++) {
      await request(app).get("/api/users/search?q=ana").set("Authorization", auth).expect(200);
    }

    const limited = await request(app).get("/api/users/search?q=ana").set("Authorization", auth).expect(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});

describe("POST /api/rooms DIRECT deduplication", () => {
  const caller = randomUUID();
  const other = randomUUID();

  beforeEach(() => {
    prismaMock.room.findFirst.mockReset();
    prismaMock.room.findUnique.mockReset();
    prismaMock.room.create.mockReset();
  });

  it("returns the existing DM (200) instead of creating a second one", async () => {
    const existing = directRoom([caller, other]);
    prismaMock.room.findFirst.mockResolvedValue(existing);

    const response = await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${tokenFor(caller)}`)
      .send({ type: "DIRECT", memberIds: [other] })
      .expect(200);

    expect(response.body.id).toBe(existing.id);
    expect(prismaMock.room.create).not.toHaveBeenCalled();
  });

  it("matches only rooms whose members are exactly the pair", async () => {
    prismaMock.room.findFirst.mockResolvedValue(null);
    prismaMock.room.create.mockResolvedValue(directRoom([caller, other]));

    await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${tokenFor(caller)}`)
      .send({ type: "DIRECT", memberIds: [other] })
      .expect(201);

    const where = prismaMock.room.findFirst.mock.calls[0]?.[0].where;
    expect(where.type).toBe("DIRECT");
    expect(where.members).toEqual({ every: { userId: { in: [caller, other] } } });
    expect(where.AND).toHaveLength(2);
  });

  it("creates the DM with a sorted pair key so the database can enforce uniqueness", async () => {
    prismaMock.room.findFirst.mockResolvedValue(null);
    prismaMock.room.create.mockResolvedValue(directRoom([caller, other]));

    await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${tokenFor(caller)}`)
      .send({ type: "DIRECT", memberIds: [other] })
      .expect(201);

    const data = prismaMock.room.create.mock.calls[0]?.[0].data;
    expect(data.directKey).toBe([caller, other].sort().join(":"));
  });

  it("falls back to the existing DM when a concurrent request wins the unique key", async () => {
    const existing = directRoom([caller, other]);
    prismaMock.room.findFirst.mockResolvedValue(null);
    prismaMock.room.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "7.10.1" }),
    );
    prismaMock.room.findUnique.mockResolvedValue(existing);

    const response = await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${tokenFor(caller)}`)
      .send({ type: "DIRECT", memberIds: [other] })
      .expect(200);

    expect(response.body.id).toBe(existing.id);
  });

  it("does not deduplicate group rooms", async () => {
    prismaMock.room.create.mockResolvedValue({ ...directRoom([caller, other]), type: "GROUP" });

    await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${tokenFor(caller)}`)
      .send({ type: "GROUP", memberIds: [other] })
      .expect(201);

    expect(prismaMock.room.findFirst).not.toHaveBeenCalled();
  });

  it("rejects DMs with more than two participants", async () => {
    await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${tokenFor(caller)}`)
      .send({ type: "DIRECT", memberIds: [other, randomUUID()] })
      .expect(400);

    expect(prismaMock.room.findFirst).not.toHaveBeenCalled();
  });
});
