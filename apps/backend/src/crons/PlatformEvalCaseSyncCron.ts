import PlatformEvalCasesRepo from "@/repositories/PlatformEvalCasesRepo";

// DEV_NOTE: Every hour (M5-5): writes the platform suite's cases (Schemas.PLATFORM_EVAL_CASES) to eval_cases, so a
// deploy reaches the database within the hour. Goes through PlatformEvalCasesRepo, never a DAL (pattern rule 1.1),
// which logs what it changed, its failures and the safety cases it couldn't turn off. Idempotent: a missed hour is
// written by the next.
export default async function runPlatformEvalCaseSync(env: Env): Promise<void> {
  await new PlatformEvalCasesRepo(env).sync();
}
