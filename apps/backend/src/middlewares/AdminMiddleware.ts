import { createMiddleware } from "hono/factory";
import AdminsRepo from "@/repositories/AdminsRepo";
import CompaniesRepo from "@/repositories/CompaniesRepo";
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

type AuthorizeResult =
  | { isAllowed: true; admin: Schemas.AdminContext }
  | { isAllowed: false; status: 403 | 500; message?: string };

// DEV_NOTE: Runs after checkAuth. The one can() check for a route (architecture baseline): resolves the signed-in
// admin (Clerk admin → company lookup) and refuses with 403 when there is no access (no admins row, a churned
// company) or can() says no.
async function authorize(
  env: Env,
  clerkUserId: string,
  action: Schemas.AuthzActionEnum,
  scope: "company" | "platform",
): Promise<AuthorizeResult> {
  const result = await new AdminsRepo(env).getAdminContext({ clerkUserId });
  if (!result.isSuccess) {
    return { isAllowed: false, status: 500, message: result.message };
  }

  const admin = result.admin;
  // DEV_NOTE: A /dashboard route acts on the admin's own company, so the resource's company is the admin's and
  // can()'s ownership check passes by construction there: it still enforces the role and action. Isolation
  // between companies comes from withTenant + RLS on c.get("companyId"). Ownership matters once a route acts
  // on a company named by the request (operator views of one company).
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
    return { isAllowed: false, status: 403, message: "Forbidden" };
  }

  return { isAllowed: true, admin };
}

// DEV_NOTE: For /dashboard/* routes on the admin's own company. Sets admin and companyId (the withTenant key).
// An operator has no company, so company routes refuse them; operator views of one company come under /operator.
export function authorizeCompany(action: Schemas.AuthzActionEnum) {
  return createMiddleware<CompanyContextEnv>(async (c, next) => {
    const result = await authorize(c.env, c.get("clerkUserId"), action, "company");
    if (!result.isAllowed) {
      return c.json({ isSuccess: false, message: result.message }, result.status);
    }
    // DEV_NOTE: can() already refused an operator here (no company); checking the role narrows companyId
    if (result.admin.role !== Schemas.AdminRoleEnum.CompanyAdmin) {
      return c.json({ isSuccess: false, message: "Forbidden" }, 403);
    }

    c.set("admin", result.admin);
    c.set("companyId", result.admin.companyId);
    await next();
  });
}

// DEV_NOTE: For /operator/* routes: operator-only actions across companies (the resource has no company), so a
// company-scoped action passed here fails closed.
export function authorizePlatform(action: Schemas.AuthzActionEnum) {
  return createMiddleware<AdminContextEnv>(async (c, next) => {
    const result = await authorize(c.env, c.get("clerkUserId"), action, "platform");
    if (!result.isAllowed) {
      return c.json({ isSuccess: false, message: result.message }, result.status);
    }

    c.set("admin", result.admin);
    await next();
  });
}

// DEV_NOTE: For /operator/companies/:companyPublicId/* routes, after authorizePlatform: resolves the company the path
// names and sets companyId (the withTenant key), so the handler acts on that one company in withTenant (pattern rule
// 3.15). An unknown company answers 404. Mounted behind authorizePlatform, so a company admin is refused (403) before
// any lookup.
export function resolveOperatorCompany() {
  return createMiddleware<CompanyContextEnv>(async (c, next) => {
    const publicId = c.req.param("companyPublicId") ?? "";
    const result = await new CompaniesRepo(c.env).resolveCompanyId({ publicId });
    if (!result.isSuccess || !result.companyId) {
      if (!result.isNotFound) {
        AppLogger.error({
          category: Schemas.LogCategory.Middleware,
          action: Schemas.LogAction.ResolveOperatorCompany,
          message: result.message ?? "Company lookup failed",
          metadata: { companyPublicId: publicId },
        });
      }
      return c.json({ isSuccess: false, message: result.message }, result.isNotFound ? 404 : 500);
    }

    c.set("companyId", result.companyId);
    await next();
  });
}
