/**
 * BARU (Update Project — AI Query).
 * BEFORE: Tidak ada file/service ini. Endpoint /ai/command hanya mengeksekusi CRUD Task
 *         (create/update/delete) berdasarkan JSON actions dari Gemini — tidak ada query baca project.
 * AFTER: Menjalankan query Prisma ke data aktual berdasarkan intent AI:
 *   1) projects_by_priority  → project yang punya task prioritas tertentu (mis. high)
 *   2) projects_by_assignee  → project yang sedang dikerjakan user tertentu
 */
import { Prisma, TaskPriority, TaskStatus } from "@prisma/client";
import { prisma } from "../prisma";
import type { AiQuery } from "../utils/ai";

const projectSelect = {
  id: true,
  name: true,
  description: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

const taskSelect = {
  id: true,
  title: true,
  status: true,
  priority: true,
  assigneeId: true,
  projectId: true,
} as const;

export type AiQueryResult = {
  intent: AiQuery["intent"];
  filters: {
    priority?: TaskPriority;
    userId?: number;
    userName?: string;
    taskStatus?: TaskStatus;
  };
  matchedUsers?: Array<{ id: number; name: string; email: string }>;
  projects: unknown[];
  summary: string;
};

async function resolveAssignees(query: AiQuery) {
  if (query.userId) {
    const user = await prisma.user.findUnique({
      where: { id: query.userId },
      select: { id: true, name: true, email: true },
    });
    return user ? [user] : [];
  }

  if (query.userName) {
    return prisma.user.findMany({
      where: {
        name: { contains: query.userName, mode: "insensitive" },
      },
      select: { id: true, name: true, email: true },
      orderBy: { id: "asc" },
    });
  }

  return [];
}

export async function executeAiQuery(query: AiQuery): Promise<AiQueryResult> {
  // Intent 1: "Saat ini project apa saja yang prioritasnya sedang high?"
  if (query.intent === "projects_by_priority") {
    const priority = (query.priority ?? TaskPriority.high) as TaskPriority;

    const projects = await prisma.project.findMany({
      where: {
        tasks: { some: { priority } },
      },
      select: {
        ...projectSelect,
        tasks: {
          where: { priority },
          select: {
            ...taskSelect,
            assignee: { select: { id: true, name: true, email: true } },
          },
          orderBy: { id: "asc" },
        },
      },
      orderBy: { id: "asc" },
    });

    return {
      intent: query.intent,
      filters: { priority },
      projects,
      summary:
        projects.length === 0
          ? `Tidak ada project yang memiliki task dengan prioritas ${priority}.`
          : `Ditemukan ${projects.length} project dengan task prioritas ${priority}.`,
    };
  }

  // Intent 2: "User A saat ini sedang mengerjakan project apa?"
  const matchedUsers = await resolveAssignees(query);
  if (matchedUsers.length === 0) {
    return {
      intent: query.intent,
      filters: {
        userId: query.userId,
        userName: query.userName,
        taskStatus: query.taskStatus as TaskStatus | undefined,
      },
      matchedUsers: [],
      projects: [],
      summary: query.userId
        ? `User dengan ID ${query.userId} tidak ditemukan.`
        : `User dengan nama "${query.userName ?? ""}" tidak ditemukan.`,
    };
  }

  const assigneeIds = matchedUsers.map((user) => user.id);
  const taskStatus = query.taskStatus as TaskStatus | undefined;
  const taskWhere: Prisma.TaskWhereInput = {
    assigneeId: { in: assigneeIds },
    ...(taskStatus ? { status: taskStatus } : {}),
  };

  const projects = await prisma.project.findMany({
    where: {
      tasks: { some: taskWhere },
    },
    select: {
      ...projectSelect,
      tasks: {
        where: taskWhere,
        select: {
          ...taskSelect,
          assignee: { select: { id: true, name: true, email: true } },
        },
        orderBy: { id: "asc" },
      },
    },
    orderBy: { id: "asc" },
  });

  const names = matchedUsers.map((user) => user.name).join(", ");
  const statusLabel = taskStatus ? ` (status: ${taskStatus})` : "";

  return {
    intent: query.intent,
    filters: {
      userId: query.userId,
      userName: query.userName,
      taskStatus,
    },
    matchedUsers,
    projects,
    summary:
      projects.length === 0
        ? `Tidak ada project yang sedang dikerjakan oleh ${names}${statusLabel}.`
        : `${names} sedang mengerjakan ${projects.length} project${statusLabel}.`,
  };
}
