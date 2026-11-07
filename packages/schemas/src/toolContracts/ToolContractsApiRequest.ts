import { z } from "zod";

// DEV_NOTE: ADR 0009. isDryRun reads the spec and derives every schema, then answers what would change and writes nothing.
export const ZSyncToolContractApiRequest = z.object({ isDryRun: z.boolean() });
export type SyncToolContractApiRequest = z.infer<typeof ZSyncToolContractApiRequest>;
