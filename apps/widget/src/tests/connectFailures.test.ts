import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import {
  NO_CONNECT_FAILURES,
  RESUME_FAILURES,
  UNAVAILABLE_FAILURES,
  nextConnectFailure,
} from "@/lib/connectFailures";

// DEV_NOTE: What failed connects lead to: dropping a saved conversation only after refused upgrades, the unavailable
// state after too many failures of any kind
function run(kinds: Schemas.WidgetConnectFailureKindEnum[], hasConversation: boolean) {
  let failures = NO_CONNECT_FAILURES;
  return kinds.map((kind) => {
    const decision = nextConnectFailure({ failures, kind, hasConversation });
    failures = decision.failures;
    return decision.action;
  });
}

const { Refused, Token } = Schemas.WidgetConnectFailureKindEnum;
const { None, DropConversation, Unavailable } = Schemas.WidgetConnectFailureActionEnum;

describe("nextConnectFailure", () => {
  it("drops a saved conversation after refused upgrades", () => {
    expect(run(Array<typeof Refused>(RESUME_FAILURES).fill(Refused), true)).toEqual([
      None,
      DropConversation,
    ]);
  });

  it("never drops a conversation over getToken failures", () => {
    expect(run([Token, Token, Refused], true)).toEqual([None, None, None]);
  });

  it("has nothing to drop without a conversation, and goes unavailable after enough failures", () => {
    const kinds = Array<typeof Refused>(UNAVAILABLE_FAILURES).fill(Refused);
    expect(run(kinds, false)).toEqual([None, None, None, None, Unavailable]);
    expect(run([Token, Refused, Token, Token, Token], true)).toEqual([
      None,
      None,
      None,
      None,
      Unavailable,
    ]);
  });
});
