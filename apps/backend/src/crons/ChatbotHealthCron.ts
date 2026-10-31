import ChatbotHealthRepo from "@/repositories/ChatbotHealthRepo";

// DEV_NOTE: Daily at Constants.CHATBOT_HEALTH_CHECK_UTC_HOUR (M5-5): yesterday's production health of every chatbot
// against its baseline (ChatbotHealthRepo.checkAll, which logs its failures and every new drop). Goes through the Repo,
// never a DAL (pattern rule 1.1). Safe to miss: a skipped day is never judged, and an open issue stays open.
export default async function runChatbotHealthCheck(env: Env): Promise<void> {
  await new ChatbotHealthRepo(env).checkAll({ now: Date.now() });
}
