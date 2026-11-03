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

// DEV_NOTE: Runs after checkAuth: resolves the signed-in admin (Clerk admin → company lookup). No admins row, or a
// churned company, is no access (403).
async function resolveAdmin(
  env: Env,
  clerkUserId: string,
): Promise<
  | { isFound: true; admin: Schemas.AdminContext }
  | { isFound: false; status: 403 | 500; message?: string }
> {
  const result = await new AdminsRepo(env).getAdminContext({ clerkUserId });
  if (!result.isSuccess) return { isFound: false, status: 500, message: result.message };
  if (!result.admin) {
    AppLogger.warn({
      category: Schemas.LogCategory.Authz,
      action: Schemas.LogAction.Authorize,
      message: "Forbidden",
      metadata: { clerkUserId, role: null },
    });
    return { isFound: false, status: 403, message: "Forbidden" };
  }
  return { isFound: true, admin: result.admin };
}

// DEV_NOTE: The one can() check for a route (architecture baseline). Isolation between companies comes from
// withTenant + RLS on the companyId the route then uses.
function authorize(
  admin: Schemas.AdminContext,
  clerkUserId: string,
  action: Schemas.AuthzActionEnum,
  resource: Schemas.AuthzResource,
): boolean {
  if (Schemas.can(admin, action, resource)) return true;
  AppLogger.warn({
    category: Schemas.LogCategory.Authz,
    action: Schemas.LogAction.Authorize,
    message: "Forbidden",
    metadata: { clerkUserId, authzAction: action, role: admin.role },
  });
  return false;
}

// DEV_NOTE: For /dashboard/* routes. Sets admin and companyId (the withTenant key). A company admin acts on their own
// company, always: any X-Acting-Company header is ignored. An operator acts on the company their header names (ADR
// 0006): resolved server-side, an unknown one 404, a churned one 403 (as for its own admins); no header = 403.
export function authorizeCompany(action: Schemas.AuthzActionEnum) {
  return createMiddleware<CompanyContextEnv>(async (c, next) => {
    const clerkUserId = c.get("clerkUserId");
    const resolved = await resolveAdmin(c.env, clerkUserId);
    if (!resolved.isFound) {
      return c.json({ isSuccess: false, message: resolved.message }, resolved.status);
    }
    const admin = resolved.admin;

    let companyId: string;
    if (admin.role === Schemas.AdminRoleEnum.CompanyAdmin) {
      companyId = admin.companyId;
    } else {
      const publicId = c.req.header(Schemas.ACTING_COMPANY_HEADER)?.trim();
      if (!publicId) return c.json({ isSuccess: false, message: "Forbidden" }, 403);
      const acting = await new CompaniesRepo(c.env).resolveActingCompany({ publicId });
      if (!acting.isSuccess || !acting.companyId) {
        if (!acting.isNotFound) {
          AppLogger.error({
            category: Schemas.LogCategory.Middleware,
            action: Schemas.LogAction.ResolveActingCompany,
            message: acting.message ?? "Company lookup failed",
            metadata: { companyPublicId: publicId },
          });
        }
        return c.json({ isSuccess: false, message: acting.message }, acting.isNotFound ? 404 : 500);
      }
      if (acting.status === Schemas.CompanyStatusIntEnum.Churned) {
        return c.json({ isSuccess: false, message: "Forbidden" }, 403);
      }
      companyId = acting.companyId;
    }

    if (!authorize(admin, clerkUserId, action, { companyId })) {
      return c.json({ isSuccess: false, message: "Forbidden" }, 403);
    }
    c.set("admin", admin);
    c.set("companyId", companyId);
    await next();
  });
}

// DEV_NOTE: For /operator/* routes: operator-only actions across companies (the resource has no company), so a
// company-scoped action passed here fails closed.
export function authorizePlatform(action: Schemas.AuthzActionEnum) {
  return createMiddleware<AdminContextEnv>(async (c, next) => {
    const clerkUserId = c.get("clerkUserId");
    const resolved = await resolveAdmin(c.env, clerkUserId);
    if (!resolved.isFound) {
      return c.json({ isSuccess: false, message: resolved.message }, resolved.status);
    }
    if (!authorize(resolved.admin, clerkUserId, action, { companyId: null })) {
      return c.json({ isSuccess: false, message: "Forbidden" }, 403);
    }

    c.set("admin", resolved.admin);
    await next();
  });
}

// DEV_NOTE: For /operator/companies/:companyPublicId/* routes, after authorizePlatform: resolves the company the path
// names and sets companyId (the withTenant key), so the handler acts on that one company in withTenant. An unknown company answers 404. Mounted behind authorizePlatform, so a company admin is refused (403) before
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
