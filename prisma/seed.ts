import bcrypt from "bcryptjs";
import { PrismaClient, Role, TaskPriority, TaskStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Keep seeding idempotent by clearing dependent tables first.
  await prisma.auditLog.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();

  const adminPassword = await bcrypt.hash("admin123", 10);
  const userPassword = await bcrypt.hash("user123", 10);

  const admin = await prisma.user.create({
    data: {
      name: "System Admin",
      email: "admin@yapindo.local",
      password: adminPassword,
      role: Role.admin,
    },
  });

  const user1 = await prisma.user.create({
    data: {
      name: "Budi User",
      email: "budi@yapindo.local",
      password: userPassword,
      role: Role.user,
    },
  });

  const user2 = await prisma.user.create({
    data: {
      name: "Sinta User",
      email: "sinta@yapindo.local",
      password: userPassword,
      role: Role.user,
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Task Management API",
      description: "Initial seeded project for technical test.",
      createdBy: admin.id,
    },
  });

  await prisma.task.createMany({
    data: [
      {
        projectId: project.id,
        title: "Setup authentication",
        description: "JWT login and register",
        status: TaskStatus.todo,
        priority: TaskPriority.high,
        assigneeId: user1.id,
      },
      {
        projectId: project.id,
        title: "Create project CRUD",
        description: "Admin project endpoints",
        status: TaskStatus.in_progress,
        priority: TaskPriority.medium,
        assigneeId: user2.id,
      },
    ],
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
