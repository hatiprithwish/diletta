import { customAlphabet } from "nanoid";

const publicIdAlphabet = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  21,
);

// DEV_NOTE: Postgres SQLSTATE for unique_violation
const UNIQUE_VIOLATION = "23505";
// DEV_NOTE: Drizzle → pg is two levels; the cap stops a cyclic cause chain from spinning forever
const MAX_CAUSE_DEPTH = 10;

export default class Utility {
  static generatePublicId(): string {
    return publicIdAlphabet();
  }

  // DEV_NOTE: base64url without padding (RFC 4648 §5), as JWTs and JWKs encode their parts. null when the input
  // isn't base64url, so a malformed token is a rejection, not an exception.
  static decodeBase64Url(encoded: string): Uint8Array<ArrayBuffer> | null {
    if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) {
      return null;
    }
    try {
      const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  // DEV_NOTE: Drizzle wraps the pg error (DrizzleQueryError.cause), so walk the cause chain. Checked by shape,
  // not instanceof: pg-protocol can load twice (worker bundle vs test alias). Lets a DAL name a clash with
  // a row RLS hides from it (a unique index spanning companies) instead of returning an unknown error.
  static isUniqueViolation(error: unknown, constraint: string): boolean {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null;
      depth++
    ) {
      if (
        "code" in current &&
        current.code === UNIQUE_VIOLATION &&
        "constraint" in current &&
        current.constraint === constraint
      ) {
        return true;
      }
      current = "cause" in current ? current.cause : undefined;
    }
    return false;
  }

  // DEV_NOTE: Passes every chunk of a stream through unchanged, shows each to onChunk, and calls onEnd exactly once:
  // when the stream finishes, fails (error set, and passed on to the reader) or is cancelled by the reader
  // (wasCancelled).
  static observeStream<TChunk>(
    source: ReadableStream<TChunk>,
    onChunk: (chunk: TChunk) => void,
    onEnd: (end: { wasCancelled: boolean; error: unknown }) => void,
  ): ReadableStream<TChunk> {
    let hasEnded = false;
    const end = (wasCancelled: boolean, error: unknown) => {
      if (hasEnded) return;
      hasEnded = true;
      onEnd({ wasCancelled, error });
    };
    const reader = source.getReader();

    return new ReadableStream<TChunk>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            end(false, null);
            controller.close();
            return;
          }
          onChunk(value);
          controller.enqueue(value);
        } catch (error) {
          end(false, error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        end(true, null);
        await reader.cancel(reason);
      },
    });
  }
}
