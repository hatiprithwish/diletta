import * as Schemas from "@app/schemas";
import { readCappedText } from "./HostHttp";

// DEV_NOTE: A company's OpenAPI spec (ADR 0009), the one host fetch that isn't a tool call and so has no auth: a public
// GET of an https URL an operator set, no credentials sent, redirects never followed, the host call timeout (body read
// included), at most TOOL_CONTRACT_MAX_BYTES, JSON only. One attempt: the hourly sync is the retry. Pure transport (no
// DB, no logger, never throws); a message never holds the body.
export type HostSpecResult =
  | { isSuccess: true; body: unknown; message: string }
  | { isSuccess: false; message: string };

export async function fetchHostSpec(params: {
  fetch: typeof fetch;
  url: string;
  signal?: AbortSignal;
}): Promise<HostSpecResult> {
  const checked = Schemas.ZToolContractUrl.safeParse(params.url);
  if (!checked.success)
    return { isSuccess: false, message: "The spec URL isn't a public https URL" };

  const timeout = AbortSignal.timeout(Schemas.HOST_CALL_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  let response: Response;
  let text: string | null;
  try {
    response = await params.fetch(checked.data, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal,
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        isSuccess: false,
        message:
          response.status >= 300 && response.status < 400
            ? "The spec URL redirects; use its final address"
            : `The host answered ${response.status} for the spec`,
      };
    }
    text = await readCappedText(response, Schemas.TOOL_CONTRACT_MAX_BYTES);
  } catch {
    return { isSuccess: false, message: "The host didn't answer for the spec" };
  }
  if (text === null) return { isSuccess: false, message: "The spec is too large" };
  try {
    return { isSuccess: true, body: JSON.parse(text) as unknown, message: "Spec fetched" };
  } catch {
    return { isSuccess: false, message: "The spec isn't JSON" };
  }
}
