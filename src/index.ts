import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { config } from "./config";
import authRoutes from "./routes/auth";
import projectRoutes from "./routes/projects";
import aiCommandRoutes from "./routes/ai-command";
import { redis, checkRedisConnection } from "./redis";
import { prisma } from "./prisma";
import auditLogRoutes from "./routes/audit-logs";

const app = express();

// Basic security and observability middlewares.
app.use(cors());
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "Yapindo technical test backend is running." });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "yapindo-technical-test-backend",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/health/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    let redisStatus: "disabled" | "ok" | "unavailable" = "disabled";
    if (redis) {
      const redisOk = await checkRedisConnection();
      redisStatus = redisOk ? "ok" : "unavailable";
    }

    return res.json({
      status: redisStatus === "unavailable" ? "degraded" : "ready",
      database: "ok",
      redis: redisStatus,
    });
  } catch (error) {
    console.error("Readiness check failed:", error);
    return res.status(503).json({
      status: "not_ready",
      message: "Dependency check failed.",
      database: "error",
    });
  }
});

// Route registration is split by domain for readability.
app.use(authRoutes);
app.use(projectRoutes);
app.use(aiCommandRoutes);
app.use(auditLogRoutes);

// Centralized fallback error handler to avoid leaking internal details.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  return res.status(500).json({ message: "Internal server error." });
});

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
  if (redis) {
    console.log("Redis cache is enabled.");
  } else {
    console.log("Redis cache is disabled (REDIS_URL not configured).");
  }
});
