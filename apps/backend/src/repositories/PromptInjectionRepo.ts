import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import PromptInjectionProvider from "@/providers/promptInjection";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — a prompt injection the Conversation DO found (M6-4), recorded in one withTenant through
// PromptInjectionProvider: the conversation's prompt_injection.detected event and, with its first one, its System
// Prompt injection issue. A failure rolls both back and is logged; the DO has already blocked the content and turned
// the conversation's changes off, which never waits on this write. The DO relays outboxIds after the commit.
export default class PromptInjectionRepo {
  private db: NodePgDatabase;

  constructor(env: Env) {
    this.db = getDbClient(env);
  }

  async recordDetection(
    params: Schemas.RecordPromptInjectionRequest,
  ): Promise<Schemas.RecordPromptInjectionResponse> {
    const recorded: Schemas.RecordPromptInjectionResponse = await withTenant(
      this.db,
      params.companyId,
      async (tx) => {
        const result = await PromptInjectionProvider.record(tx, params);
        if (!result.isSuccess) {
          throw new TenantRollbackError(result.message ?? "Prompt injection not recorded");
        }
        return result;
      },
    );
    if (!recorded.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.RecordPromptInjection,
        message: recorded.message ?? "Prompt injection not recorded",
        metadata: {
          companyId: params.companyId,
          conversationPublicId: params.conversationPublicId,
          location: params.location,
          ruleId: params.ruleId,
        },
      });
    }
    return recorded;
  }
}
