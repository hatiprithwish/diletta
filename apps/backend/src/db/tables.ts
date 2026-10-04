import { sql } from "drizzle-orm";
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

// DEV_NOTE: Tenancy root. companies.id is the tenant key that withTenant puts in app.company_id.
export const companies = table(
  "companies",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    name: t.text().notNull(),
    status: t.smallint().$type<Schemas.CompanyStatusIntEnum>().notNull().default(1), // CompanyStatusIntEnum.Active
    isReadOnly: t.boolean("is_read_only").notNull().default(false),
    spendingBudget: t.numeric("spending_budget", { precision: 12, scale: 6 }),
    contentRetentionDays: t.integer("content_retention_days"),
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id, null = system
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_companies_public_id").on(table.publicId),
    t.index("IDX_companies_updated_by").on(table.updatedBy),
  ],
);

// DEV_NOTE: Golden tenant table. company_id on every row; the DAL filters on it inside withTenant.
export const chatbots = table(
  "chatbots",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    name: t.text().notNull(),
    status: t.smallint().$type<Schemas.ChatbotStatusIntEnum>().notNull().default(1), // ChatbotStatusIntEnum.Active
    isDefault: t.boolean("is_default").notNull().default(false),
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, null = system
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id, null = system
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_chatbots_public_id").on(table.publicId),
    // DEV_NOTE: At most one default chatbot per company — the widget loads it when no bot id is given
    t
      .uniqueIndex("UNQ_chatbots_company_id_default")
      .on(table.companyId)
      .where(sql`${table.isDefault}`),
    t.index("IDX_chatbots_company_id").on(table.companyId),
    t.index("IDX_chatbots_created_by").on(table.createdBy),
    t.index("IDX_chatbots_updated_by").on(table.updatedBy),
  ],
);
