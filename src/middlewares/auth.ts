import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { config } from "../config";
import { JwtPayload } from "../types";

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; role: Role };
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing bearer token." });
  }

  // Verify JWT and attach user context to request for downstream handlers.
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;
    req.user = { id: decoded.userId, role: decoded.role };
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid token." });
  }
}

export function authorize(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthenticated." });
    }
    // Block access when role does not match the route policy.
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden." });
    }
    return next();
  };
}
