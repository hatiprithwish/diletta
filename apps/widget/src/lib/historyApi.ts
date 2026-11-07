import * as Schemas from "@app/schemas";

// DEV_NOTE: The widget's history reads (GET /widget/conversations and /widget/conversations/:publicId) with a fresh
// companion JWT as a bearer token, like the bootstrap read. Every body is parsed before use; a network failure, a
// refused token or a body that doesn't parse is failed (the screen offers a retry). notFound: the chat isn't this
// user's or is gone (404).
async function getJson(url: URL, params: Schemas.WidgetHistoryFetchParams) {
  if (params.chatbot) url.searchParams.set("chatbot", params.chatbot);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${params.token}` },
    credentials: "omit",
    signal: params.signal,
  });
  return {
    status: response.status,
    body: response.ok ? ((await response.json()) as unknown) : null,
  };
}

export async function fetchConversations(
  params: Schemas.WidgetConversationsFetchParams,
): Promise<Schemas.WidgetHistoryFetchResult<Schemas.WidgetConversationsApiResponse>> {
  const url = new URL("/widget/conversations", params.apiBase);
  url.searchParams.set("pageNo", String(params.pageNo));
  try {
    const { body } = await getJson(url, params);
    const parsed = Schemas.ZWidgetConversationsApiResponse.safeParse(body);
    return parsed.success && parsed.data.conversations
      ? { status: "ok", data: parsed.data }
      : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

export async function fetchPastConversation(
  params: Schemas.WidgetPastConversationFetchParams,
): Promise<Schemas.WidgetHistoryFetchResult<Schemas.WidgetPastConversation>> {
  const url = new URL(
    `/widget/conversations/${encodeURIComponent(params.publicId)}`,
    params.apiBase,
  );
  try {
    const { status, body } = await getJson(url, params);
    if (status === 404) return { status: "notFound" };
    const parsed = Schemas.ZWidgetConversationApiResponse.safeParse(body);
    return parsed.success && parsed.data.conversation
      ? { status: "ok", data: parsed.data.conversation }
      : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}
