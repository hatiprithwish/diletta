import { sqliteTable as table } from "drizzle-orm/sqlite-core";
import * as t from "drizzle-orm/sqlite-core";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: SQLite does not have bigInt support

export const users = table(
  "users",
  {
    id: t.int().primaryKey({ autoIncrement: true }),
    publicId: t.text("public_id").notNull(),
    clerkId: t.text("clerk_id").notNull(),
    email: t.text().notNull(),
    role: t.text().$type<Schemas.UserRoleEnum>().notNull(),
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }).notNull(),
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
    id: t.int().primaryKey({ autoIncrement: true }),
    publicId: t.text("public_id").notNull(),
    userId: t.text("user_id").notNull(),
    title: t.text().notNull(),
    body: t.text(),
    status: t.integer().$type<Schemas.NoteStatusIntEnum>().notNull().default(1), // NoteStatusIntEnum.Draft
    createdAt: t.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: t.integer("updated_at", { mode: "timestamp" }),
  },
  (table) => [
    t.uniqueIndex("UNQ_notes_public_id").on(table.publicId),
    t.index("IDX_notes_user_id").on(table.userId),
  ],
);
