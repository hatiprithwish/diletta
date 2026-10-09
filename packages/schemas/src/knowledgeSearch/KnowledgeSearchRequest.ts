// DEV_NOTE: Server-side only — one knowledge search (KnowledgeSearchRepo.search), from the Conversation DO's tool.
// Internal ids from the conversation's session; they stamp the search's model_calls rows. sourcePublicIds is the bot's
// config knowledge.sourceIds as stored (public ids); topK its loaded knowledge.topK.
export interface SearchKnowledgeRequest {
  companyId: string;
  chatbotId: string;
  chatbotUserId: string;
  conversationId: string;
  turnId: string;
  sourcePublicIds: string[];
  topK: number;
  query: string;
}
