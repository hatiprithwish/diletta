import * as Schemas from "@app/schemas";

// DEV_NOTE: GET /widget/bootstrap (ADR 0002) with a fresh companion JWT as a bearer token. Any failure (network,
// a refused token, a body that doesn't parse) is null: the widget shows its unavailable state and offers a retry.
export async function fetchBootstrap(
  params: Schemas.WidgetBootstrapFetchParams,
): Promise<Schemas.WidgetBootstrap | null> {
  const url = new URL("/widget/bootstrap", params.apiBase);
  if (params.chatbot) url.searchParams.set("chatbot", params.chatbot);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${params.token}` },
      credentials: "omit",
      signal: params.signal,
    });
    if (!response.ok) return null;
    const parsed = Schemas.ZWidgetBootstrapApiResponse.safeParse(await response.json());
    return parsed.success && parsed.data.bootstrap ? parsed.data.bootstrap : null;
  } catch {
    return null;
  }
}
