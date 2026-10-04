import { pgTable as table } from "drizzle-orm/pg-core";
import * as t from "drizzle-orm/pg-core";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: bigint ids use mode "string" (exact int64, JSON-safe). id is internal only — never sent to a client.

export const users = table(
  "users",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    clerkId: t.text("clerk_id").notNull(),
    email: t.text().notNull(),
    role: t.text().$type<Schemas.UserRoleEnum>().notNull(),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_users_public_id").on(table.publicId),
    t.uniqueIndex("UNQ_users_clerk_id").on(table.clerkId),
    t.uniqueIndex("UNQ_users_email").on(table.email),
  ],
);

export const notes = table(
  "notes",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    title: t.text().notNull(),
    body: t.text(),
    status: t.smallint().$type<Schemas.NoteStatusIntEnum>().notNull().default(1), // NoteStatusIntEnum.Draft
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_notes_public_id").on(table.publicId),
    t.index("IDX_notes_user_id").on(table.userId),
  ],
);
