import { createMiddleware } from "hono/factory";
import AdminsRepo from "@/repositories/AdminsRepo";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";
import type AppContext from "@/config/AppContext";
import type { AdminVariables, CompanyVariables } from "@/config/AppContext";

type AdminContextEnv = {
  Bindings: Env;
  Variables: AppContext["Variables"] & AdminVariables;
};

type CompanyContextEnv = {
  Bindings: Env;
  Variables: AppContext["Variables"] & AdminVariables & CompanyVariables;
};

// DEV_NOTE: Runs after checkAuth. The one can() check for a route (architecture baseline): resolves the signed-in
// admin (Clerk admin → company lookup) and refuses with 403 when there is no admins row or can() says no.
async function authorize(
  env: Env,
  clerkUserId: string,
  action: Schemas.AuthzActionEnum,
  scope: "company" | "platform",
): Promise<{ admin?: Schemas.AdminContext; status?: 403 | 500; message?: string }> {
  const result = await new AdminsRepo(env).getAdminContext({ clerkUserId });
  if (!result.isSuccess) {
    return { status: 500, message: result.message };
  }

  const admin = result.admin;
  const resource: Schemas.AuthzResource = {
    companyId: scope === "company" ? (admin?.companyId ?? null) : null,
  };
  if (!admin || !Schemas.can(admin, action, resource)) {
    AppLogger.warn({
      category: Schemas.LogCategory.Authz,
      action: Schemas.LogAction.Authorize,
      message: "Forbidden",
      metadata: { clerkUserId, authzAction: action, role: admin?.role ?? null },
    });
    return { status: 403, message: "Forbidden" };
  }

  return { admin };
}

// DEV_NOTE: For /dashboard/* routes on the admin's own company. Sets admin and companyId (the withTenant key).
// An operator has no company, so company routes refuse them; operator views of one company come under /operator.
export function authorizeCompany(action: Schemas.AuthzActionEnum) {
  return createMiddleware<CompanyContextEnv>(async (c, next) => {
    const { admin, status, message } = await authorize(
      c.env,
      c.get("clerkUserId"),
      action,
      "company",
    );
    if (!admin) {
      return c.json({ isSuccess: false, message }, status === 500 ? 500 : 403);
    }
    // DEV_NOTE: can() already refused a company action without a company; this narrows companyId to string
    if (admin.companyId === null) {
      return c.json({ isSuccess: false, message: "Forbidden" }, 403);
    }

    c.set("admin", admin);
    c.set("companyId", admin.companyId);
    await next();
  });
}

// DEV_NOTE: For /operator/* routes: operator-only actions across companies (the resource has no company), so a
// company-scoped action passed here fails closed.
export function authorizePlatform(action: Schemas.AuthzActionEnum) {
  return createMiddleware<AdminContextEnv>(async (c, next) => {
    const { admin, status, message } = await authorize(
      c.env,
      c.get("clerkUserId"),
      action,
      "platform",
    );
    if (!admin) {
      return c.json({ isSuccess: false, message }, status === 500 ? 500 : 403);
    }

    c.set("admin", admin);
    await next();
  });
}
