import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { toLoggableError } from "@/providers/logger";

describe("toLoggableError", () => {
  it("logs a failed query as its SQL, pg code and names, never the bound values", () => {
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "UNQ_x"'),
      {
        code: "23505",
        constraint: "UNQ_x",
        table: "company_connections",
        column: undefined,
        detail: "Key (jwt_issuer)=(https://secret-issuer.example.com) already exists.",
      },
    );
    const error = new DrizzleQueryError(
      'insert into "company_connections" ("auth_config") values ($1)',
      ['{"clientSecret":"s3cr3t"}', "Asha Rao"],
      pgError,
    );

    const logged = toLoggableError(error);
    expect(logged).toEqual({
      name: "DrizzleQueryError",
      query: 'insert into "company_connections" ("auth_config") values ($1)',
      cause: {
        code: "23505",
        constraint: "UNQ_x",
        table: "company_connections",
        column: undefined,
      },
    });
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("Asha Rao");
    expect(serialized).not.toContain("secret-issuer");
  });

  it("keeps only the name of a non-pg cause", () => {
    const error = new DrizzleQueryError("select 1", ["Asha Rao"], new TypeError("Asha Rao"));
    expect(toLoggableError(error)).toEqual({
      name: "DrizzleQueryError",
      query: "select 1",
      cause: { name: "TypeError" },
    });
  });

  it("passes any other error through unchanged", () => {
    const error = new Error("Transaction rolled back");
    expect(toLoggableError(error)).toBe(error);
  });
});
