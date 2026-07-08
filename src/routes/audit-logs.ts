import { Router } from "express";
import { Role } from "@prisma/client";
import { authenticate, authorize } from "../middlewares/auth";
import { prisma } from "../prisma";

const router = Router();

// Simple admin endpoint to inspect AI command activity.
router.get("/audit-logs", authenticate, authorize(Role.admin), async (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  const safeLimit = Number.isNaN(limit) ? 20 : Math.min(Math.max(limit, 1), 100);

  const logs = await prisma.auditLog.findMany({
    take: safeLimit,
    orderBy: { createdAt: "desc" },
    include: {
      user: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
  });

  return res.json(logs);
});

export default router;
