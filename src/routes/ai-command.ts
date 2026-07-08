import { Router } from "express";
import { AuditStatus, Prisma, Role, TaskPriority, TaskStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma";
import { authenticate, authorize } from "../middlewares/auth";
import { deleteByPattern } from "../redis";
import { callGemini } from "../utils/ai";

const router = Router();

const bodySchema = z.object({
  prompt: z.string().min(3),
});

function containsUserTableIntent(prompt: string): boolean {
  const lowered = prompt.toLowerCase();
  // Block User-table mutations only. "assign ke user ID 2" is valid (task assignee).
  const userTableMutationPatterns = [
    /(hapus|delete|remove|ubah|update|edit|modify|change|buat|create)\s+user(s)?(\s|$|\.)/,
    /user(s)?\s+(table|tabel|akun|account)/,
    /(tabel|table)\s+user(s)?/,
  ];
  return userTableMutationPatterns.some((pattern) => pattern.test(lowered));
}

router.post("/ai/command", authenticate, authorize(Role.admin, Role.user), async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body." });
  }

  const { prompt } = parsed.data;
  if (containsUserTableIntent(prompt)) {
    // Requirement: still log failed AI command attempts.
    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: "AI_COMMAND",
        requestPayload: { prompt },
        responsePayload: { message: "User table operation is not allowed." },
        status: AuditStatus.failed,
        failedReason: "USER_TABLE_OPERATION_NOT_ALLOWED",
      },
    });
    return res.status(400).json({ message: "User table operation is not allowed." });
  }

  try {
    // Gemini response is validated by Zod schema in callGemini().
    const aiOutput = await callGemini(prompt);
    if (aiOutput.actions.length === 0) {
      await prisma.auditLog.create({
        data: {
          userId: req.user!.id,
          action: "AI_COMMAND",
          requestPayload: { prompt },
          responsePayload: aiOutput,
          status: AuditStatus.failed,
          failedReason: "EMPTY_ACTIONS",
        },
      });
      return res.status(400).json({ message: "AI command does not contain executable actions." });
    }

    // Atomic execution: all actions succeed or everything is rolled back.
    const results = await prisma.$transaction(async (tx) => {
      const mutationResults: unknown[] = [];

      for (const action of aiOutput.actions) {
        if (action.operation === "create") {
          if (!action.data?.projectId || !action.data.title || !action.data.assigneeId) {
            throw new Error("Create action requires projectId, title, assigneeId.");
          }

          const created = await tx.task.create({
            data: {
              projectId: action.data.projectId,
              title: action.data.title,
              description: action.data.description,
              assigneeId: action.data.assigneeId,
              status: action.data.status ?? TaskStatus.todo,
              priority: action.data.priority ?? TaskPriority.medium,
            },
          });
          mutationResults.push(created);
        }

        if (action.operation === "update") {
          if (!action.taskId || !action.data) {
            throw new Error("Update action requires taskId and data.");
          }

          const updated = await tx.task.update({
            where: { id: action.taskId },
            data: {
              title: action.data.title,
              description: action.data.description,
              status: action.data.status,
              priority: action.data.priority,
              assigneeId: action.data.assigneeId,
            },
          });
          mutationResults.push(updated);
        }

        if (action.operation === "delete") {
          if (!action.taskId) {
            throw new Error("Delete action requires taskId.");
          }

          const deleted = await tx.task.delete({
            where: { id: action.taskId },
          });
          mutationResults.push(deleted);
        }
      }

      return mutationResults;
    });

    const responsePayload = structuredClone({
      aiOutput,
      results,
    }) as Prisma.InputJsonValue;

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: "AI_COMMAND",
        requestPayload: { prompt },
        responsePayload,
        status: AuditStatus.success,
      },
    });

    // Task mutations can affect task list endpoints, invalidate related Redis cache.
    await deleteByPattern("cache:projects:*:tasks");

    return res.json({
      message: "AI command executed successfully.",
      aiOutput,
      results,
    });
  } catch (error) {
    // Any parsing/db/runtime failure is captured and returned as safe 400 response.
    const reason = error instanceof Error ? error.message : "UNKNOWN_ERROR";

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: "AI_COMMAND",
        requestPayload: { prompt },
        responsePayload: { error: reason },
        status: AuditStatus.failed,
        failedReason: reason,
      },
    });

    return res.status(400).json({
      message: "Failed to execute AI command.",
      error: reason,
    });
  }
});

export default router;
