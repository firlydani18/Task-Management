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

  // BEFORE (seed lama): hanya 1 project:
  //   const project = await prisma.project.create({
  //     data: {
  //       name: "Task Management API",
  //       description: "Initial seeded project for technical test.",
  //       createdBy: admin.id,
  //     },
  //   });
  // AFTER: 3 project agar query AI "high priority" & "user sedang mengerjakan" punya data demo.
  const projectApi = await prisma.project.create({
    data: {
      name: "Task Management API",
      // BEFORE: description: "Initial seeded project for technical test."
      description: "Backend API untuk technical test.",
      createdBy: admin.id,
    },
  });

  const projectMobile = await prisma.project.create({
    data: {
      name: "Mobile Companion App",
      description: "Aplikasi mobile companion untuk task management.",
      createdBy: admin.id,
    },
  });

  const projectDashboard = await prisma.project.create({
    data: {
      name: "Admin Dashboard",
      description: "Dashboard monitoring project & audit log.",
      createdBy: admin.id,
    },
  });

  // BEFORE (seed lama — hanya 2 task di 1 project):
  // await prisma.task.createMany({
  //   data: [
  //     {
  //       projectId: project.id,
  //       title: "Setup authentication",
  //       description: "JWT login and register",
  //       status: TaskStatus.todo,          // <- dulu todo
  //       priority: TaskPriority.high,
  //       assigneeId: user1.id,
  //     },
  //     {
  //       projectId: project.id,
  //       title: "Create project CRUD",
  //       description: "Admin project endpoints",
  //       status: TaskStatus.in_progress,
  //       priority: TaskPriority.medium,
  //       assigneeId: user2.id,
  //     },
  //   ],
  // });
  // AFTER: lebih banyak task lintas project + status/prioritas bervariasi untuk demo AI query.
  await prisma.task.createMany({
    data: [
      {
        projectId: projectApi.id,
        title: "Setup authentication",
        description: "JWT login and register",
        // BEFORE: status: TaskStatus.todo
        status: TaskStatus.in_progress,
        priority: TaskPriority.high,
        assigneeId: user1.id,
      },
      {
        projectId: projectApi.id,
        title: "Create project CRUD",
        description: "Admin project endpoints",
        status: TaskStatus.in_progress,
        priority: TaskPriority.medium,
        assigneeId: user2.id,
      },
      // BARU: task di project Mobile (belum ada di seed lama)
      {
        projectId: projectMobile.id,
        title: "Design login screen",
        description: "UI login mobile",
        status: TaskStatus.in_progress,
        priority: TaskPriority.high,
        assigneeId: user1.id,
      },
      {
        projectId: projectMobile.id,
        title: "Push notification",
        description: "Integrasi FCM",
        status: TaskStatus.todo,
        priority: TaskPriority.low,
        assigneeId: user2.id,
      },
      // BARU: task di project Dashboard (belum ada di seed lama)
      {
        projectId: projectDashboard.id,
        title: "Audit log chart",
        description: "Visualisasi audit sukses/gagal",
        status: TaskStatus.todo,
        priority: TaskPriority.medium,
        assigneeId: user2.id,
      },
      {
        projectId: projectDashboard.id,
        title: "Role-based menus",
        description: "Menu berbeda per role",
        status: TaskStatus.done,
        priority: TaskPriority.high,
        assigneeId: user1.id,
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
