import "dotenv/config";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as createSocketClient, type Socket } from "socket.io-client";
import request from "supertest";

const databaseConfigured = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL ??=
  "postgresql://test:test@127.0.0.1:5432/proyecto3_test";
process.env.JWT_SECRET ??= "integration-test-secret";
process.env.GEMINI_API_KEY ??= "integration-test-gemini-key";

const geminiMock = vi.hoisted(() => ({
  generateContentStream: vi.fn(async () =>
    (async function* () {
      yield { text: "Hola " };
      yield { text: "desde Gemini" };
    })(),
  ),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContentStream: geminiMock.generateContentStream,
    };
  },
}));

const [{ app, httpServer, io }, { prisma }, { removeExpiredDemoAccounts }] = await Promise.all([
  import("../src/index.js"),
  import("../src/services/prisma.service.js"),
  import("../src/services/demo.service.js"),
]);

const describeWithDatabase = describe.skipIf(!databaseConfigured);

function uniqueAccount() {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return {
    email: `test-${suffix}@example.com`,
    username: `test_${suffix}`,
    password: "integration-password",
  };
}

function waitForEvent<T>(
  socket: Socket,
  event: string,
  timeout = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    const onEvent = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

describeWithDatabase("chat API and Socket.io integration", () => {
  const userIds: string[] = [];
  let baseUrl: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    await prisma.$connect();

    const account = uniqueAccount();
    const registration = await request(app)
      .post("/api/auth/register")
      .send(account)
      .expect(201);
    userId = registration.body.user.id as string;
    token = registration.body.token as string;
    userIds.push(userId);

    httpServer.listen(0);
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine test server port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await prisma.room.deleteMany({
        where: {
          members: {
            some: { userId: { in: userIds } },
          },
        },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }

    await new Promise<void>((resolve, reject) => {
      io.close((error) => (error ? reject(error) : resolve()));
    });
    await prisma.$disconnect();
  });

  it("registers and logs in users with valid JWTs", async () => {
    const account = uniqueAccount();
    const registration = await request(app)
      .post("/api/auth/register")
      .send(account)
      .expect(201);
    userIds.push(registration.body.user.id as string);

    expect(registration.body.user).not.toHaveProperty("passwordHash");
    expect(jwt.verify(registration.body.token as string, process.env.JWT_SECRET!)).toMatchObject({
      userId: registration.body.user.id,
      username: account.username,
    });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(200);
    expect(jwt.verify(login.body.token as string, process.env.JWT_SECRET!)).toMatchObject({
      userId: registration.body.user.id,
      username: account.username,
    });
    expect(login.body.user).not.toHaveProperty("passwordHash");
  });

  it.each([
    ["without a token", {}],
    ["with an invalid token", { token: "not-a-valid-jwt" }],
  ])("rejects Socket.io connections %s", async (_label, auth) => {
    const socket = createSocketClient(baseUrl, {
      auth,
      transports: ["websocket"],
      reconnection: false,
    });
    try {
      await waitForEvent(socket, "connect_error");
    } finally {
      socket.disconnect();
    }
  });

  it("creates rooms, returns history, and streams AI messages to members", async () => {
    const memberAccount = uniqueAccount();
    const memberRegistration = await request(app)
      .post("/api/auth/register")
      .send(memberAccount)
      .expect(201);
    userIds.push(memberRegistration.body.user.id as string);

    const roomResponse = await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Integration assistant",
        type: "AI_ASSISTANT",
        memberIds: [memberRegistration.body.user.id],
      })
      .expect(201);
    const roomId = roomResponse.body.id as string;
    expect(roomResponse.body.members).toHaveLength(2);

    const rooms = await request(app)
      .get("/api/rooms")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(rooms.body.some((room: { id: string }) => room.id === roomId)).toBe(true);

    const socket = createSocketClient(baseUrl, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });
    try {
      await waitForEvent(socket, "connect");

      const roomJoined = waitForEvent<{ roomId: string }>(socket, "room:joined");
      socket.emit("room:join", roomId);
      await expect(roomJoined).resolves.toEqual({ roomId });

      const newMessage = waitForEvent<{ roomId: string; content: string }>(
        socket,
        "message:new",
      );
      const streamStart = waitForEvent<{
        messageId: string;
        roomId: string;
        createdAt: string;
      }>(socket, "ai:stream_start");
      const chunks: string[] = [];
      socket.on(
        "ai:stream_chunk",
        (event: { messageId: string; roomId: string; chunk: string }) => {
          chunks.push(event.chunk);
        },
      );
      const streamEnd = waitForEvent<{
        messageId: string;
        roomId: string;
        content: string;
        status: string;
      }>(socket, "ai:stream_end");
      geminiMock.generateContentStream.mockClear();
      geminiMock.generateContentStream.mockRejectedValueOnce(
        Object.assign(
          new Error(
            JSON.stringify({
              error: {
                code: 503,
                status: "UNAVAILABLE",
                message: "Temporarily overloaded",
              },
            }),
          ),
          { status: 503 },
        ),
      );

      socket.emit("message:send", {
        roomId,
        content: "Saluda en español",
      });

      await expect(newMessage).resolves.toMatchObject({
        roomId,
        content: "Saluda en español",
      });
      const start = await streamStart;
      expect(start).toMatchObject({ roomId });
      expect(start.messageId).toBeTruthy();
      expect(start.createdAt).toBeTruthy();

      const end = await streamEnd;
      expect(end).toMatchObject({
        messageId: start.messageId,
        roomId,
        content: "Hola desde Gemini",
        status: "COMPLETED",
      });
      expect(chunks).toEqual(["Hola ", "desde Gemini"]);
      expect(geminiMock.generateContentStream).toHaveBeenCalledTimes(2);

      const history = await request(app)
        .get(`/api/rooms/${roomId}/messages?page=1&limit=10`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(history.body.messages).toHaveLength(2);
      expect(history.body.messages[0].sender).toMatchObject({
        username: registrationUsername(token),
      });
      expect(history.body.messages[1]).toMatchObject({
        id: start.messageId,
        isAi: true,
        content: "Hola desde Gemini",
        status: "COMPLETED",
        sender: null,
      });
    } finally {
      socket.disconnect();
    }
  });

  it("protects room routes and rejects history access for non-members", async () => {
    await request(app).get("/api/rooms").expect(401);

    const otherAccount = uniqueAccount();
    const otherRegistration = await request(app)
      .post("/api/auth/register")
      .send(otherAccount)
      .expect(201);
    userIds.push(otherRegistration.body.user.id as string);

    const room = await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "GROUP" })
      .expect(201);

    await request(app)
      .get(`/api/rooms/${room.body.id}/messages`)
      .set("Authorization", `Bearer ${otherRegistration.body.token}`)
      .expect(404);
  });

  it("requires direct messages to have exactly two members", async () => {
    const memberRegistration = await request(app)
      .post("/api/auth/register")
      .send(uniqueAccount())
      .expect(201);
    const extraRegistration = await request(app)
      .post("/api/auth/register")
      .send(uniqueAccount())
      .expect(201);
    userIds.push(
      memberRegistration.body.user.id as string,
      extraRegistration.body.user.id as string,
    );

    await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "DIRECT",
        memberIds: [memberRegistration.body.user.id, extraRegistration.body.user.id],
      })
      .expect(400);

    await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "DIRECT", memberIds: [memberRegistration.body.user.id] })
      .expect(201);
  });

  it("reuses the existing DM between the same two users", async () => {
    const peer = await request(app).post("/api/auth/register").send(uniqueAccount()).expect(201);
    userIds.push(peer.body.user.id as string);

    const first = await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "DIRECT", memberIds: [peer.body.user.id] })
      .expect(201);
    const second = await request(app)
      .post("/api/rooms")
      .set("Authorization", `Bearer ${peer.body.token}`)
      .send({ type: "DIRECT", memberIds: [userId] })
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
  });

  it("searches users by partial email without exposing private fields or the caller", async () => {
    const account = uniqueAccount();
    const peer = await request(app).post("/api/auth/register").send(account).expect(201);
    userIds.push(peer.body.user.id as string);

    const response = await request(app)
      .get(`/api/users/search?q=${account.email.slice(0, 12).toUpperCase()}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual([
      {
        id: peer.body.user.id,
        email: account.email,
        username: account.username,
        avatarUrl: null,
      },
    ]);
    await request(app)
      .get(`/api/users/search?q=${account.username}`)
      .set("Authorization", `Bearer ${peer.body.token}`)
      .expect(200)
      .expect((res) => expect(res.body.some((user: { id: string }) => user.id === peer.body.user.id)).toBe(false));
  });

  it("creates isolated demo guests whose bot DM replies in realtime", async () => {
    const guest = await request(app).post("/api/auth/demo").expect(201);
    userIds.push(guest.body.user.id as string);
    expect(guest.body.user).not.toHaveProperty("passwordHash");

    const rooms = await request(app)
      .get("/api/rooms")
      .set("Authorization", `Bearer ${guest.body.token}`)
      .expect(200);
    const directMessage = rooms.body.find((room: { type: string }) => room.type === "DIRECT");
    const bot = directMessage.members.find(
      (member: { user: { username: string } }) => member.user.username === "relay_guide",
    );
    expect(bot).toBeDefined();
    expect(rooms.body.some((room: { type: string }) => room.type === "AI_ASSISTANT")).toBe(true);

    const socket = createSocketClient(baseUrl, {
      auth: { token: guest.body.token },
      transports: ["websocket"],
      reconnection: false,
    });
    try {
      await waitForEvent(socket, "connect");
      const roomJoined = waitForEvent(socket, "room:joined");
      socket.emit("room:join", directMessage.id);
      await roomJoined;

      const botReply = new Promise<{ senderId: string | null }>((resolve) => {
        socket.on("message:new", (message: { senderId: string | null }) => {
          if (message.senderId === bot.user.id) {
            resolve(message);
          }
        });
      });
      socket.emit("message:send", { roomId: directMessage.id, content: "Hola bot" });
      await expect(botReply).resolves.toMatchObject({ senderId: bot.user.id });
    } finally {
      socket.disconnect();
    }

    const otherGuest = await request(app).post("/api/auth/demo").expect(201);
    userIds.push(otherGuest.body.user.id as string);
    await request(app)
      .get(`/api/rooms/${directMessage.id}/messages`)
      .set("Authorization", `Bearer ${otherGuest.body.token}`)
      .expect(404);

    const intruder = createSocketClient(baseUrl, {
      auth: { token: otherGuest.body.token },
      transports: ["websocket"],
      reconnection: false,
    });
    try {
      await waitForEvent(intruder, "connect");
      const denied = waitForEvent<{ roomId: string }>(intruder, "error:event");
      intruder.emit("room:join", directMessage.id);
      await expect(denied).resolves.toMatchObject({ roomId: directMessage.id });
    } finally {
      intruder.disconnect();
    }
  });

  it("removes demo guests after their 24-hour session", async () => {
    const guest = await request(app).post("/api/auth/demo").expect(201);

    const removed = await removeExpiredDemoAccounts(Date.now() + 25 * 60 * 60 * 1000);

    expect(removed).toBeGreaterThan(0);
    await expect(
      prisma.user.findUnique({ where: { id: guest.body.user.id as string } }),
    ).resolves.toBeNull();
  });
});

function registrationUsername(token: string): string {
  const payload = jwt.verify(token, process.env.JWT_SECRET!);
  if (typeof payload === "string" || typeof payload.username !== "string") {
    throw new Error("JWT does not contain username");
  }
  return payload.username;
}
