import { env } from "cloudflare:test";
import app from "@/index";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Drives the test host app in workerd with its real Durable Object. Each test uses its own workspace, so no
// test sees another's records or faults.
export const newWorkspace = () => `ws_${crypto.randomUUID().replace(/-/g, "")}`;

export const adminHeaders = () => ({
  [Schemas.TEST_HOST_ADMIN_HEADER]: env.TEST_HOST_ADMIN_SECRET,
  "Content-Type": "application/json",
});

export async function mintTokens(
  workspace: string,
  overrides: Partial<Schemas.TestHostTokenRequest> = {},
): Promise<Schemas.TestHostTokenResponse> {
  const response = await app.request(
    "/auth/tokens",
    {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ workspace, sub: "user_1", ...overrides }),
    },
    env,
  );
  if (response.status !== 201) throw new Error(`Token mint failed: ${response.status}`);
  return response.json<Schemas.TestHostTokenResponse>();
}

export async function api(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey !== undefined) {
    headers[Schemas.HOST_IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(
    path,
    {
      method,
      headers,
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    },
    env,
  );
}

export async function setFaults(workspace: string, faults: Schemas.TestHostFault[]) {
  const response = await app.request(
    `/control/workspaces/${workspace}/faults`,
    { method: "PUT", headers: adminHeaders(), body: JSON.stringify({ faults }) },
    env,
  );
  if (response.status !== 200) throw new Error(`Setting faults failed: ${response.status}`);
}

export async function readRecord(token: string, id: string) {
  const response = await api("GET", `/v1/records/${id}`, { token });
  return response.status === 200
    ? Schemas.ZTestHostRecordResponse.parse(await response.json()).data
    : null;
}

export function decodePart(jwt: string, index: 0 | 1): unknown {
  const part = jwt.split(".")[index]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part));
}
