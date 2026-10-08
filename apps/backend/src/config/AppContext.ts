import type * as Schemas from "@app/schemas";

interface AuthVariables {
  clerkUserId: string;
  clerkEmail: string;
  clerkSessionId: string;
}

// DEV_NOTE: Set by authorizeCompany / authorizePlatform (AdminMiddleware). Typed on those middlewares, so a
// handler sees them only when its chain includes one. admin carries internal ids: never put it in a response.
export interface AdminVariables {
  admin: Schemas.AdminContext;
}

// DEV_NOTE: Set by authorizeCompany only — the signed-in admin's internal companies.id, the withTenant key
export interface CompanyVariables {
  companyId: string;
}

interface AppContext {
  Bindings: Env;
  Variables: AuthVariables;
}

export default AppContext;
