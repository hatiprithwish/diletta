import { Hono } from "hono";
import * as Schemas from "@app/schemas";
import AdminsRepo from "@/repositories/AdminsRepo";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import { auditActorFor } from "@/repositories/audit";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";

// DEV_NOTE: Mounted at /dashboard. /me is the dashboard's sign-in check and the only route that creates an admin
// (first sign-in from a Clerk invite), so it runs without authorizeCompany: any Clerk user may ask who they are.
const AdminsRoutes = new Hono<AppContext>();

AdminsRoutes.get("/me", checkAuth, async (c) => {
  const repo = new AdminsRepo(c.env);
  const response = await repo.getMe({
    clerkUserId: c.get("clerkUserId"),
    sessionEmail: c.get("clerkEmail"),
  });

  if (!response.isSuccess) {
    return c.json(response, 500);
  }
  return c.json(response, response.admin ? 200 : 403);
});

// DEV_NOTE: ADR 0006. An operator picked the company in X-Acting-Company: records their entry in its audit log. Only
// an operator may (CompanyActAs is operator-only), so a company admin gets 403.
AdminsRoutes.post(
  "/acting",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.CompanyActAs),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompaniesRepo(c.env);
    const { outboxIds, ...response } = await repo.recordOperatorActed({
      companyId,
      actor: auditActorFor(c.get("admin")),
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

export default AdminsRoutes;
