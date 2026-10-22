import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/conversations/")({
  component: ConversationsPage,
});

function ConversationsPage() {
  return <PageHeader title="Conversations" description="Every chat with your bots" />;
}
