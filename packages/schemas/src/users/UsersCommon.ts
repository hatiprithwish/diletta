import { z } from "zod";

export enum UserRoleEnum {
  User = "user",
  Admin = "admin",
}

export const ZUserRoleEnum = z.enum(UserRoleEnum);

export interface UserBase {
  clerkId: string;
  email: string;
  role: UserRoleEnum;
}

export interface User extends UserBase {
  publicId: string;
  createdAt: Date;
  updatedAt?: Date | null;
}
