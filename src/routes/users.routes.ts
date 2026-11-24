import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { rateLimitBy } from "../middlewares/rate-limit.middleware.js";
import { createRateLimiter } from "../services/rate-limit.service.js";
import { prisma } from "../services/prisma.service.js";

const router = Router();

const searchSchema = z.object({
  q: z.string().trim().min(2).max(60),
});

const searchRateLimit = rateLimitBy(
  createRateLimiter({ windowMs: 60 * 1000, max: 30 }),
  (request) => request.userId,
);

router.use(requireAuth);

// Only public fields are selected explicitly: never passwordHash, lastSeen or timestamps.
router.get("/search", searchRateLimit, async (request, response) => {
  const parsed = searchSchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: "Search must be between 2 and 60 characters" });
    return;
  }

  const term = parsed.data.q;
  const users = await prisma.user.findMany({
    where: {
      id: { not: request.userId },
      // Guest accounts are throwaway and their emails are not meant to be discoverable.
      isDemo: false,
      OR: [
        { email: { contains: term, mode: "insensitive" } },
        { username: { contains: term, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      email: true,
      username: true,
      avatarUrl: true,
    },
    orderBy: { username: "asc" },
    take: 8,
  });

  response.json(users);
});

export default router;
