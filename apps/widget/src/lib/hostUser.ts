// DEV_NOTE: Which host user a companion JWT is for (its sub), read without verifying it: only to key the saved
// conversation in this browser. The platform verifies every token; nothing here trusts it.
export function hostUserOf(token: string): string | null {
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
