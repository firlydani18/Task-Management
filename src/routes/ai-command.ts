import { Router } from "express";
import { AuditStatus, Prisma, Role, TaskPriority, TaskStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma";
import { authenticate, authorize } from "../middlewares/auth";
import { deleteByPattern } from "../redis";
// BEFORE:
// import { callGemini } from "../utils/ai";
// AFTER: Tambah callGeminiStreaming + type AiCommand untuk mode query/mutate.
import { callGemini, callGeminiStreaming, type AiCommand } from "../utils/ai";
// BARU: Service query DB aktual (sebelumnya tidak ada — AI hanya mutate Task).
import { executeAiQuery } from "../services/ai-query";

const router = Router();

// BEFORE:
// const bodySchema = z.object({
//   prompt: z.string().min(3),
// });
// AFTER: Tambah flag stream untuk SSE response (plus point).
const bodySchema = z.object({
  prompt: z.string().min(3),
  /** When true, responds with Server-Sent Events (text/event-stream). */
  stream: z.boolean().optional().default(false),
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

// BARU: Helper SSE — sebelum update, response selalu res.json(...) saja.
function writeSse(res: import("express").Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * BEFORE: Logic create/update/delete Task berada inline di dalam handler POST /ai/command
 *         (langsung di dalam prisma.$transaction setelah callGemini) — lihat blok comment
 *         "KODE LAMA HANDLER" di bawah.
 * AFTER: Diekstrak ke executeMutations() agar handler bisa dipakai ulang untuk JSON & stream.
 */
async function executeMutations(aiOutput: Extract<AiCommand, { mode: "mutate" }>) {
  // Atomic execution: all actions succeed or everything is rolled back.
  return prisma.$transaction(async (tx) => {
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
}

/**
 * BEFORE: Handler hanya mendukung mutate — setelah AI return actions, langsung transaction Task CRUD,
 *         lalu res.json({ message, aiOutput, results }). Tidak ada cabang query.
 * AFTER: Cabang mode "query" (query DB aktual) + mode "mutate" (CRUD lama),
 *        serta output JSON biasa ATAU SSE jika stream=true.
 */
async function handleAiCommand(
  userId: number,
  prompt: string,
  aiOutput: AiCommand,
  res: import("express").Response,
  stream: boolean,
) {
  // BARU: mode query — contoh prompt high priority / project by user.
  // BEFORE: Intent seperti ini tidak ditangani (AI wajib return actions CRUD).
  if (aiOutput.mode === "query") {
    const data = await executeAiQuery(aiOutput.query);
    const responsePayload = structuredClone({
      mode: "query",
      aiOutput,
      data,
    }) as Prisma.InputJsonValue;

    await prisma.auditLog.create({
      data: {
        userId,
        // BEFORE: action selalu "AI_COMMAND" untuk semua request.
        // AFTER: Query read-only dicatat sebagai "AI_QUERY".
        action: "AI_QUERY",
        requestPayload: { prompt, stream },
        responsePayload,
        status: AuditStatus.success,
      },
    });

    if (stream) {
      writeSse(res, "result", {
        message: "AI query executed successfully.",
        mode: "query",
        aiOutput,
        data,
      });
      writeSse(res, "done", { ok: true });
      return res.end();
    }

    return res.json({
      message: "AI query executed successfully.",
      mode: "query",
      aiOutput,
      data,
    });
  }

  // --- Mode mutate (perilaku sebelum update, tetap dipertahankan) ---
  if (aiOutput.actions.length === 0) {
    await prisma.auditLog.create({
      data: {
        userId,
        action: "AI_COMMAND",
        // BEFORE: requestPayload: { prompt }
        // AFTER: requestPayload: { prompt, stream }
        requestPayload: { prompt, stream },
        responsePayload: aiOutput,
        status: AuditStatus.failed,
        failedReason: "EMPTY_ACTIONS",
      },
    });

    if (stream) {
      writeSse(res, "error", { message: "AI command does not contain executable actions." });
      writeSse(res, "done", { ok: false });
      return res.end();
    }

    return res.status(400).json({ message: "AI command does not contain executable actions." });
  }

  const results = await executeMutations(aiOutput);
  // BEFORE:
  // const responsePayload = structuredClone({
  //   aiOutput,
  //   results,
  // }) as Prisma.InputJsonValue;
  // AFTER: ditambah mode: "mutate" agar konsisten dengan response query.
  const responsePayload = structuredClone({
    mode: "mutate",
    aiOutput,
    results,
  }) as Prisma.InputJsonValue;

  await prisma.auditLog.create({
    data: {
      userId,
      action: "AI_COMMAND",
      // BEFORE: requestPayload: { prompt }
      requestPayload: { prompt, stream },
      responsePayload,
      status: AuditStatus.success,
    },
  });

  // Task mutations can affect task list endpoints, invalidate related Redis cache.
  await deleteByPattern("cache:projects:*:tasks");

  if (stream) {
    writeSse(res, "result", {
      message: "AI command executed successfully.",
      mode: "mutate",
      aiOutput,
      results,
    });
    writeSse(res, "done", { ok: true });
    return res.end();
  }

  // BEFORE:
  // return res.json({
  //   message: "AI command executed successfully.",
  //   aiOutput,
  //   results,
  // });
  return res.json({
    message: "AI command executed successfully.",
    mode: "mutate",
    aiOutput,
    results,
  });
}

/*
 * ===================================================================================
 * KODE LAMA HANDLER POST /ai/command (sebelum Update Project) — disimpan sebagai referensi
 * ===================================================================================
 *
 * router.post("/ai/command", authenticate, authorize(Role.admin, Role.user), async (req, res) => {
 *   const parsed = bodySchema.safeParse(req.body);
 *   if (!parsed.success) {
 *     return res.status(400).json({ message: "Invalid request body." });
 *   }
 *
 *   const { prompt } = parsed.data;
 *   if (containsUserTableIntent(prompt)) {
 *     await prisma.auditLog.create({
 *       data: {
 *         userId: req.user!.id,
 *         action: "AI_COMMAND",
 *         requestPayload: { prompt },
 *         responsePayload: { message: "User table operation is not allowed." },
 *         status: AuditStatus.failed,
 *         failedReason: "USER_TABLE_OPERATION_NOT_ALLOWED",
 *       },
 *     });
 *     return res.status(400).json({ message: "User table operation is not allowed." });
 *   }
 *
 *   try {
 *     // Gemini response is validated by Zod schema in callGemini().
 *     const aiOutput = await callGemini(prompt);
 *     if (aiOutput.actions.length === 0) {
 *       await prisma.auditLog.create({
 *         data: {
 *           userId: req.user!.id,
 *           action: "AI_COMMAND",
 *           requestPayload: { prompt },
 *           responsePayload: aiOutput,
 *           status: AuditStatus.failed,
 *           failedReason: "EMPTY_ACTIONS",
 *         },
 *       });
 *       return res.status(400).json({ message: "AI command does not contain executable actions." });
 *     }
 *
 *     // Atomic execution: all actions succeed or everything is rolled back.
 *     const results = await prisma.$transaction(async (tx) => {
 *       const mutationResults: unknown[] = [];
 *
 *       for (const action of aiOutput.actions) {
 *         if (action.operation === "create") {
 *           if (!action.data?.projectId || !action.data.title || !action.data.assigneeId) {
 *             throw new Error("Create action requires projectId, title, assigneeId.");
 *           }
 *
 *           const created = await tx.task.create({
 *             data: {
 *               projectId: action.data.projectId,
 *               title: action.data.title,
 *               description: action.data.description,
 *               assigneeId: action.data.assigneeId,
 *               status: action.data.status ?? TaskStatus.todo,
 *               priority: action.data.priority ?? TaskPriority.medium,
 *             },
 *           });
 *           mutationResults.push(created);
 *         }
 *
 *         if (action.operation === "update") {
 *           if (!action.taskId || !action.data) {
 *             throw new Error("Update action requires taskId and data.");
 *           }
 *
 *           const updated = await tx.task.update({
 *             where: { id: action.taskId },
 *             data: {
 *               title: action.data.title,
 *               description: action.data.description,
 *               status: action.data.status,
 *               priority: action.data.priority,
 *               assigneeId: action.data.assigneeId,
 *             },
 *           });
 *           mutationResults.push(updated);
 *         }
 *
 *         if (action.operation === "delete") {
 *           if (!action.taskId) {
 *             throw new Error("Delete action requires taskId.");
 *           }
 *
 *           const deleted = await tx.task.delete({
 *             where: { id: action.taskId },
 *           });
 *           mutationResults.push(deleted);
 *         }
 *       }
 *
 *       return mutationResults;
 *     });
 *
 *     const responsePayload = structuredClone({
 *       aiOutput,
 *       results,
 *     }) as Prisma.InputJsonValue;
 *
 *     await prisma.auditLog.create({
 *       data: {
 *         userId: req.user!.id,
 *         action: "AI_COMMAND",
 *         requestPayload: { prompt },
 *         responsePayload,
 *         status: AuditStatus.success,
 *       },
 *     });
 *
 *     await deleteByPattern("cache:projects:*:tasks");
 *
 *     return res.json({
 *       message: "AI command executed successfully.",
 *       aiOutput,
 *       results,
 *     });
 *   } catch (error) {
 *     const reason = error instanceof Error ? error.message : "UNKNOWN_ERROR";
 *
 *     await prisma.auditLog.create({
 *       data: {
 *         userId: req.user!.id,
 *         action: "AI_COMMAND",
 *         requestPayload: { prompt },
 *         responsePayload: { error: reason },
 *         status: AuditStatus.failed,
 *         failedReason: reason,
 *       },
 *     });
 *
 *     return res.status(400).json({
 *       message: "Failed to execute AI command.",
 *       error: reason,
 *     });
 *   }
 * });
 */

router.post("/ai/command", authenticate, authorize(Role.admin, Role.user), async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request body." });
  }

  // BEFORE: const { prompt } = parsed.data;
  const { prompt, stream } = parsed.data;
  const userId = req.user!.id;

  if (containsUserTableIntent(prompt)) {
    // Requirement: still log failed AI command attempts.
    await prisma.auditLog.create({
      data: {
        userId,
        action: "AI_COMMAND",
        // BEFORE: requestPayload: { prompt }
        requestPayload: { prompt, stream },
        responsePayload: { message: "User table operation is not allowed." },
        status: AuditStatus.failed,
        failedReason: "USER_TABLE_OPERATION_NOT_ALLOWED",
      },
    });
    return res.status(400).json({ message: "User table operation is not allowed." });
  }

  try {
    // BARU: jalur stream (SSE). BEFORE: selalu callGemini() lalu res.json(...).
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      writeSse(res, "status", { stage: "calling_gemini" });

      const aiOutput = await callGeminiStreaming(prompt, (delta) => {
        writeSse(res, "ai_delta", { text: delta });
      });

      writeSse(res, "ai_intent", { aiOutput });
      writeSse(res, "status", { stage: "executing" });

      await handleAiCommand(userId, prompt, aiOutput, res, true);
      return;
    }

    // Jalur non-stream (perilaku sebelum update — JSON response).
    // Gemini response is validated by Zod schema in callGemini().
    // BEFORE (inline mutate only — diganti handleAiCommand agar dukung query + stream):
    // const aiOutput = await callGemini(prompt);
    // if (aiOutput.actions.length === 0) { ... return 400 }
    // const results = await prisma.$transaction(async (tx) => { ... });
    // return res.json({ message: "AI command executed successfully.", aiOutput, results });
    const aiOutput = await callGemini(prompt);
    await handleAiCommand(userId, prompt, aiOutput, res, false);
  } catch (error) {
    // Any parsing/db/runtime failure is captured and returned as safe 400 response.
    const reason = error instanceof Error ? error.message : "UNKNOWN_ERROR";

    await prisma.auditLog.create({
      data: {
        userId,
        action: "AI_COMMAND",
        // BEFORE: requestPayload: { prompt }
        requestPayload: { prompt, stream },
        responsePayload: { error: reason },
        status: AuditStatus.failed,
        failedReason: reason,
      },
    });

    // BARU: jika header SSE sudah terkirim, error dikirim sebagai event (bukan res.status.json).
    // BEFORE:
    // return res.status(400).json({
    //   message: "Failed to execute AI command.",
    //   error: reason,
    // });
    if (stream && res.headersSent) {
      writeSse(res, "error", {
        message: "Failed to execute AI command.",
        error: reason,
      });
      writeSse(res, "done", { ok: false });
      return res.end();
    }

    return res.status(400).json({
      message: "Failed to execute AI command.",
      error: reason,
    });
  }
});

export default router;
