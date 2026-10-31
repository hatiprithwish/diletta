-- Down for 20261030051048_diletta: drops why the harness stopped an eval run (M5-3)
ALTER TABLE "eval_runs" DROP COLUMN IF EXISTS "failure";
