import { Role } from "@prisma/client";

export type JwtPayload = {
  userId: number;
  role: Role;
};

export type AuthUser = {
  id: number;
  role: Role;
};
