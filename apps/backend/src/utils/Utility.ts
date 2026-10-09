import { customAlphabet } from "nanoid";

const publicIdAlphabet = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  21,
);

// DEV_NOTE: ULID (https://github.com/ulid/spec): 10 chars of millisecond time + 16 chars of randomness, Crockford
// base32, so ids sort by creation time as text
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;
const ULID_MAX_TIME = 2 ** 48 - 1;
// DEV_NOTE: Monotonic within an isolate: a second id in the same millisecond increments the last one's randomness,
// so two turns minted back to back still sort in order. Only ordering state, never request data.
let lastUlidTime = -1;
let lastUlidRandom: number[] = [];

// DEV_NOTE: Postgres SQLSTATE for unique_violation
const UNIQUE_VIOLATION = "23505";
// DEV_NOTE: Drizzle → pg is two levels; the cap stops a cyclic cause chain from spinning forever
const MAX_CAUSE_DEPTH = 10;

export default class Utility {
  static generatePublicId(): string {
    return publicIdAlphabet();
  }

  // DEV_NOTE: The Conversation DO's turn_id (messages, tool_calls, model_calls). now is injectable for tests only.
  static generateUlid(now: number = Date.now()): string {
    if (!Number.isInteger(now) || now < 0 || now > ULID_MAX_TIME) {
      throw new RangeError("ULID time out of range");
    }

    let random: number[];
    if (now <= lastUlidTime) {
      // DEV_NOTE: Same (or an earlier, clock-skewed) millisecond: keep the last time and add one to its randomness
      random = [...lastUlidRandom];
      let index = random.length - 1;
      while (index >= 0 && random[index] === ULID_ALPHABET.length - 1) {
        random[index] = 0;
        index--;
      }
      if (index < 0) throw new RangeError("ULID randomness exhausted in one millisecond");
      random[index] = (random[index] ?? 0) + 1;
      now = lastUlidTime;
    } else {
      const bytes = crypto.getRandomValues(new Uint8Array(ULID_RANDOM_LENGTH));
      random = [...bytes].map((byte) => byte % ULID_ALPHABET.length);
    }
    lastUlidTime = now;
    lastUlidRandom = random;

    let time = "";
    let remaining = now;
    for (let i = 0; i < ULID_TIME_LENGTH; i++) {
      time = ULID_ALPHABET.charAt(remaining % ULID_ALPHABET.length) + time;
      remaining = Math.floor(remaining / ULID_ALPHABET.length);
    }
    return time + random.map((digit) => ULID_ALPHABET.charAt(digit)).join("");
  }

  // DEV_NOTE: null instead of a throw for text that isn't JSON, so untrusted input is a rejection, not an exception
  static parseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
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
