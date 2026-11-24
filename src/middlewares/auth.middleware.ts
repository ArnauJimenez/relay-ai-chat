import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export function requireAuth(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const authorization = request.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  const jwtSecret = process.env.JWT_SECRET;

  if (!token || !jwtSecret) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    if (
      typeof payload === "string" ||
      typeof payload.userId !== "string"
    ) {
      response.status(401).json({ error: "Invalid authentication token" });
      return;
    }

    request.userId = payload.userId;
    next();
  } catch {
    response.status(401).json({ error: "Invalid authentication token" });
  }
}
