import { Hono } from "hono";
import AdminsRepo from "@/repositories/AdminsRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import type AppContext from "@/config/AppContext";

// DEV_NOTE: Mounted at /dashboard. /me is the dashboard's sign-in check and the only route that creates an admin
// (first sign-in from a Clerk invite), so it runs without authorizeCompany: any Clerk user may ask who they are.
const AdminsRoutes = new Hono<AppContext>();

AdminsRoutes.get("/me", checkAuth, async (c) => {
  const clerkUserId = c.get("clerkUserId");

  const repo = new AdminsRepo(c.env);
  const response = await repo.getMe({ clerkUserId });

  if (!response.isSuccess) {
    return c.json(response, 500);
  }
  return c.json(response, response.admin ? 200 : 403);
});

export default AdminsRoutes;
