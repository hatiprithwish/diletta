import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// DEV_NOTE: Owner fixtures insert quality_issues rows by hand; every app write sets chatbot_id (M5-5) and the Quality
// reads need it, so a fixture gets its conversation's chatbot afterwards, as the migration's backfill did
export async function setQualityIssueChatbots(
  ownerDb: NodePgDatabase,
  companyIds: string[],
): Promise<void> {
  if (companyIds.length === 0) return;
  await ownerDb.execute(sql`
    update quality_issues as q set chatbot_id = c.chatbot_id
      from conversations as c
     where c.id = q.conversation_id and c.company_id = q.company_id and q.chatbot_id is null
       and q.company_id in (${sql.join(
         companyIds.map((id) => sql`${id}`),
         sql`, `,
       )})`);
}
