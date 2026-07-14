import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
// BARU (kelengkapan testing API): Swagger UI + OpenAPI spec.
// BEFORE: Tidak ada swagger-ui-express / docs OpenAPI di entry point.
import swaggerUi from "swagger-ui-express";
import path from "path";
import fs from "fs";
import { config } from "./config";
import authRoutes from "./routes/auth";
import projectRoutes from "./routes/projects";
import aiCommandRoutes from "./routes/ai-command";
import { redis, checkRedisConnection } from "./redis";
import { prisma } from "./prisma";
import auditLogRoutes from "./routes/audit-logs";

const app = express();

// BARU: load OpenAPI dari docs/openapi.json.
// BEFORE: file ini tidak diload / tidak ada Swagger.
const openApiPath = path.join(__dirname, "..", "docs", "openapi.json");
const openApiDocument = JSON.parse(fs.readFileSync(openApiPath, "utf-8")) as Record<string, unknown>;

// Basic security and observability middlewares.
app.use(cors());
// BEFORE:
// app.use(helmet());
// AFTER: CSP dimatikan agar Swagger UI (inline assets) bisa jalan di /docs.
app.use(
  helmet({
    // Allow Swagger UI assets to load in development/demo.
    contentSecurityPolicy: false,
  }),
);
app.use(morgan("dev"));
app.use(express.json());

// BEFORE:
// app.get("/", (_req, res) => {
//   res.json({ message: "Yapindo technical test backend is running." });
// });
// AFTER: Tambah link docs & openapi agar mudah ditemukan.
app.get("/", (_req, res) => {
  res.json({
    message: "Yapindo technical test backend is running.",
    docs: "/docs",
    openapi: "/docs/openapi.json",
  });
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

// BARU: endpoint dokumentasi API (sebelumnya belum ada Swagger di project).
// BEFORE: tidak ada route /docs dan /docs/openapi.json.
app.get("/docs/openapi.json", (_req, res) => {
  res.json(openApiDocument);
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument, {
  customSiteTitle: "Yapindo API Docs",
}));

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
  // BEFORE:
  // console.log(`Server running on http://localhost:${config.port}`);
  // (tanpa log Swagger)
  // AFTER: tambah log link Swagger.
  console.log(`Swagger UI: http://localhost:${config.port}/docs`);
  if (redis) {
    console.log("Redis cache is enabled.");
  } else {
    console.log("Redis cache is disabled (REDIS_URL not configured).");
  }
});
