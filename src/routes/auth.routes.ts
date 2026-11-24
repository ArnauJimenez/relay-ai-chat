import { Router } from "express";
import { Prisma } from "@prisma/client";
import { compare, hash } from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { rateLimitByIp } from "../middlewares/rate-limit.middleware.js";
import { createGuestSession } from "../services/demo.service.js";
import { createRateLimiter } from "../services/rate-limit.service.js";
import { prisma } from "../services/prisma.service.js";

const router = Router();

const authRateLimit = rateLimitByIp(
  createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 }),
);
const demoRateLimit = rateLimitByIp(
  createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 }),
);

const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  username: z
    .string()
    .trim()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(8).max(72),
});

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(8).max(72),
});

function createToken(
  user: { id: string; username: string },
  expiresIn: "24h" | "7d" = "7d",
): string {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET must be set");
  }

  return jwt.sign(
    { userId: user.id, username: user.username },
    jwtSecret,
    { subject: user.id, expiresIn },
  );
}

router.post("/register", authRateLimit, async (request, response) => {
  const parsed = credentialsSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid registration details" });
    return;
  }

  try {
    const user = await prisma.user.create({
      data: {
        email: parsed.data.email,
        username: parsed.data.username,
        passwordHash: await hash(parsed.data.password, 12),
      },
      select: {
        id: true,
        email: true,
        username: true,
        avatarUrl: true,
        createdAt: true,
      },
    });

    response.status(201).json({
      token: createToken(user),
      user,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      response.status(409).json({ error: "Email or username already exists" });
      return;
    }

    throw error;
  }
});

router.post("/demo", demoRateLimit, async (_request, response) => {
  const guest = await createGuestSession();

  response.status(201).json({
    token: createToken(guest, "24h"),
    user: guest,
  });
});

router.post("/login", authRateLimit, async (request, response) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid login details" });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: {
      id: true,
      username: true,
      email: true,
      avatarUrl: true,
      createdAt: true,
      passwordHash: true,
    },
  });

  if (!user || !(await compare(parsed.data.password, user.passwordHash))) {
    response.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const { passwordHash: _passwordHash, ...safeUser } = user;
  response.json({
    token: createToken(user),
    user: safeUser,
  });
});

export default router;
