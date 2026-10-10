// DEV_NOTE: Which host user a companion JWT is for (its sub), read without verifying it: only to key the saved
// conversation in this browser. The platform verifies every token; nothing here trusts it. The sub may be an email,
// so only its SHA-256 (hex) is kept or written to localStorage. null when the token has no readable sub.
export async function hostUserOf(token: string): Promise<string | null> {
  const sub = subOf(token);
  if (sub === null) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    return null;
  }
}

function subOf(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && "sub" in parsed && typeof parsed.sub === "string") {
      return parsed.sub;
    }
    return null;
  } catch {
    return null;
  }
}
