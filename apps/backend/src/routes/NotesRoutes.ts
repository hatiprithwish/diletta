import { Hono } from "hono";
import NotesRepo from "@/repositories/NotesRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";
import { zValidator } from "@hono/zod-validator";
import z from "zod";

const NotesRoutes = new Hono<AppContext>();

NotesRoutes.post("/", checkAuth, zValidator("json", Schemas.ZCreateNoteApiRequest), async (c) => {
  const userId = c.get("clerkUserId");
  const body = c.req.valid("json");

  const repo = new NotesRepo(c.env);
  const response = await repo.createNote({
    note: body.note,
    userId,
  });

  return c.json(response, response.isSuccess ? 201 : 500);
});

NotesRoutes.get("/", checkAuth, async (c) => {
  const userId = c.get("clerkUserId");

  const repo = new NotesRepo(c.env);
  const response = await repo.getNotes({ userId });

  return c.json(response, response.isSuccess ? 200 : 500);
});

NotesRoutes.get(
  "/:publicId",
  checkAuth,
  zValidator("param", z.object({ publicId: z.string() })),
  async (c) => {
    const userId = c.get("clerkUserId");
    const { publicId } = c.req.valid("param");

    const repo = new NotesRepo(c.env);
    const response = await repo.getNoteDetails({ publicId, userId });

    return c.json(response, response.isSuccess ? 200 : 404);
  },
);

NotesRoutes.patch(
  "/:publicId",
  checkAuth,
  zValidator("param", z.object({ publicId: z.string() })),
  zValidator("json", Schemas.ZUpdateNoteApiRequest),
  async (c) => {
    const userId = c.get("clerkUserId");
    const { publicId } = c.req.valid("param");
    const body = c.req.valid("json");

    const repo = new NotesRepo(c.env);
    const response = await repo.updateNote({ publicId, userId, ...body });

    return c.json(response, response.isSuccess ? 200 : 404);
  },
);

NotesRoutes.delete(
  "/:publicId",
  checkAuth,
  zValidator("param", z.object({ publicId: z.string() })),
  async (c) => {
    const userId = c.get("clerkUserId");
    const { publicId } = c.req.valid("param");

    const repo = new NotesRepo(c.env);
    const response = await repo.deleteNote({ publicId, userId });

    return c.json(response, response.isSuccess ? 200 : 404);
  },
);

export default NotesRoutes;
