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
}
