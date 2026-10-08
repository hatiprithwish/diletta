import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizePlatform } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Operator routes, mounted at /operator/companies. Chain: checkAuth → authorizePlatform(action)
// → zValidator → handler. Creating and listing companies span every company, so CompaniesRepo runs them in
// withPlatform (pattern rule 3.15).
const CompaniesRoutes = new Hono<AppContext>();

CompaniesRoutes.post(
  "/",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyCreate),
  zValidator("json", Schemas.ZCreateCompanyApiRequest),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.createCompany(c.req.valid("json"));

    return c.json(response, response.isSuccess ? 201 : 500);
  },
);

CompaniesRoutes.get(
  "/",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyList),
  zValidator("query", Schemas.ZGetCompaniesApiRequest),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.getCompanies(c.req.valid("query"));

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

CompaniesRoutes.get(
  "/count",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyList),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.getCompaniesCount();

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

export default CompaniesRoutes;
