import { WorkerEntrypoint } from "cloudflare:workers";
import app from "@/app";
import { disposeLogger } from "@/providers/logger";
import EvalRunnerRepo from "@/repositories/EvalRunnerRepo";
import * as Schemas from "@app/schemas";

// DEV_NOTE: M7-9 (ADR 0007). The hosted eval runner's service binding into the backend (apps/eval-runner binds it with
// entrypoint "EvalRunnerEntrypoint"). Not a route: only a Worker of this account with that binding can call it, so the
// decrypted test sign-in getRunLogin answers never crosses the internet, a log or a route response. Each method takes
// the Workflow instance's params (public ids), checked again here, and answers { isSuccess, message } shapes.
export class EvalRunnerEntrypoint extends WorkerEntrypoint<Env> {
  // DEV_NOTE: The runner's /eval/runs* calls, sent over this binding instead of the internet: a Workers Free invocation
  // may make 50 subrequests to the internet but 1,000 to Cloudflare services, and a run makes several per attempt. The
  // same app, routes and authenticateEval as the public worker; any other path is 404.
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/eval/runs" && !pathname.startsWith("/eval/runs/")) {
      return Response.json({ isSuccess: false, message: "Not found" }, { status: 404 });
    }
    this.ctx.waitUntil(disposeLogger());
    return await app.fetch(request, this.env, this.ctx);
  }

  // DEV_NOTE: The run's connection's test sign-in, while the run is Queued or Running (EvalRunnerRepo.getRunLogin)
  async getRunLogin(params: unknown): Promise<Schemas.EvalRunLoginResponse> {
    const parsed = Schemas.ZEvalRunWorkflowParams.safeParse(params);
    if (!parsed.success) return { isSuccess: false, message: "Invalid run params" };
    try {
      return await new EvalRunnerRepo(this.env).getRunLogin(parsed.data);
    } finally {
      this.ctx.waitUntil(disposeLogger());
    }
  }

  // DEV_NOTE: The runner couldn't start the run: Queued → Failed with the stop it hit. A started run is left alone.
  async failQueuedRun(params: unknown): Promise<Schemas.ApiResponse> {
    const parsed = Schemas.ZFailQueuedEvalRunParams.safeParse(params);
    if (!parsed.success) return { isSuccess: false, message: "Invalid run params" };
    try {
      return await new EvalRunnerRepo(this.env).failQueuedRun(parsed.data);
    } finally {
      this.ctx.waitUntil(disposeLogger());
    }
  }
}
