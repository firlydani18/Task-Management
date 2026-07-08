import { Router } from "express";
import { Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma";
import { authenticate, authorize } from "../middlewares/auth";
import { deleteCache, getCachedJson, setCachedJson } from "../redis";

const router = Router();

const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const projectListCacheKey = "cache:projects:list";
const projectTasksCacheKey = (projectId: number) => `cache:projects:${projectId}:tasks`;

// Read project list: both admin and user are allowed.
router.get("/projects", authenticate, authorize(Role.admin, Role.user), async (_req, res) => {
  const cached = await getCachedJson<unknown[]>(projectListCacheKey);
  if (cached) {
    return res.json(cached);
  }

  const projects = await prisma.project.findMany({
    include: {
      creator: { select: { id: true, name: true, email: true } },
    },
    orderBy: { id: "asc" },
  });

  await setCachedJson(projectListCacheKey, projects);
  return res.json(projects);
});

router.get("/projects/:id", authenticate, authorize(Role.admin, Role.user), async (req, res) => {
  const projectId = Number(req.params.id);
  if (Number.isNaN(projectId)) return res.status(400).json({ message: "Invalid id." });

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { creator: { select: { id: true, name: true, email: true } } },
  });
  if (!project) return res.status(404).json({ message: "Project not found." });
  return res.json(project);
});

router.post("/projects", authenticate, authorize(Role.admin), async (req, res) => {
  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body." });
  }

  // createdBy is always inferred from the authenticated admin.
  const project = await prisma.project.create({
    data: {
      ...parsed.data,
      createdBy: req.user!.id,
    },
  });

  await deleteCache(projectListCacheKey);
  return res.status(201).json(project);
});

router.put("/projects/:id", authenticate, authorize(Role.admin), async (req, res) => {
  const projectId = Number(req.params.id);
  if (Number.isNaN(projectId)) return res.status(400).json({ message: "Invalid id." });

  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body." });
  }

  const existing = await prisma.project.findUnique({ where: { id: projectId } });
  if (!existing) return res.status(404).json({ message: "Project not found." });

  const project = await prisma.project.update({
    where: { id: projectId },
    data: parsed.data,
  });

  await deleteCache(projectListCacheKey);
  return res.json(project);
});

router.delete("/projects/:id", authenticate, authorize(Role.admin), async (req, res) => {
  const projectId = Number(req.params.id);
  if (Number.isNaN(projectId)) return res.status(400).json({ message: "Invalid id." });

  const existing = await prisma.project.findUnique({ where: { id: projectId } });
  if (!existing) return res.status(404).json({ message: "Project not found." });

  // Related tasks will be deleted due to onDelete: Cascade in Prisma schema.
  await prisma.project.delete({ where: { id: projectId } });
  await deleteCache(projectListCacheKey);
  await deleteCache(projectTasksCacheKey(projectId));
  return res.status(204).send();
});

router.get(
  "/projects/:id/tasks",
  authenticate,
  authorize(Role.admin, Role.user),
  async (req, res) => {
    const projectId = Number(req.params.id);
    if (Number.isNaN(projectId)) return res.status(400).json({ message: "Invalid id." });

    const cacheKey = projectTasksCacheKey(projectId);
    const cached = await getCachedJson<unknown[]>(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ message: "Project not found." });

    const tasks = await prisma.task.findMany({
      where: { projectId },
      include: { assignee: { select: { id: true, name: true, email: true } } },
      orderBy: { id: "asc" },
    });

    await setCachedJson(cacheKey, tasks);
    return res.json(tasks);
  },
);

export default router;
